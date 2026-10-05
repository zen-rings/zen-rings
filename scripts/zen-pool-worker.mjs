#!/usr/bin/env node
// zen-pool-worker — the job side of Zen Pool: register once, then serve tasks until told to stop.
//
// One GitHub Actions run becomes a request/response service instead of a one-shot launcher:
//   1. register  -> get a lease (this is the "регистрируется у нас" moment);
//   2. pull      -> long-poll, up to ~20 s per call, so an idle job costs ~180 calls/hour
//                   instead of 3600 (one per second) and the answer is pushed the instant a task
//                   appears — no tunnel, no inbound address, nothing to expose;
//   3. serve     -> call zen with the task's model/prompt, POST the text back;
//   4. bye       -> exit 0 on idle TTL or on POST /zen/pool/stop ("а потом её убиваем").
//
// Exit codes: 0 = told to stop (clean), 2 = the provider refused (the run goes red on purpose —
// a green job must never mean "nothing ran"), 3 = the pool is unreachable/misconfigured.
//
// Usage:
//   node scripts/zen-pool-worker.mjs --url https://llm-ladder.trainedassist.store \
//       --token $ZEN_RUNNER_TOKEN [--idle-exit 600000] [--max-tasks 0]

import { writeFileSync } from 'node:fs';
import { createZenClient } from './zen-client.mjs';

const T0 = Date.now();
const iso = () => new Date().toISOString();
const marks = [];
const mark = (stage, extra = {}) => {
  const at = Date.now();
  marks.push({ stage, at, iso: iso(), ms_since_start: at - T0, ...extra });
  console.log(`POOL ${stage} ${iso()} +${at - T0}ms${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`);
  return at;
};

function parse(argv) {
  const out = { idleExit: 600000, maxTasks: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--idle-exit') out.idleExit = Number(argv[++i]) || out.idleExit;
    else if (a === '--max-tasks') out.maxTasks = Number(argv[++i]) || 0;
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

const args = parse(process.argv.slice(2));
mark('process_start', { node: process.version, url: args.url || null });

const base = String(args.url || process.env.ZEN_RUNNER_URL || '').replace(/\/+$/, '');
const token = String(args.token || process.env.ZEN_RUNNER_TOKEN || '').trim();
if (!base || !token) {
  console.log('POOL_CONFIG_MISSING --url and --token (or ZEN_RUNNER_URL / ZEN_RUNNER_TOKEN) are both required');
  process.exit(3);
}

const workerId = [
  process.env.ZEN_POOL_REPO || process.env.GITHUB_REPOSITORY || 'local',
  process.env.GITHUB_RUN_ID || '0',
  process.env.GITHUB_RUN_ATTEMPT || '1',
].join(':');

const client = createZenClient({
  ratePerMin: 50,
  // Per MODEL, per process — the client keeps one counter per model, so MiMo and Nemotron never
  // share this budget. Same 700 as the controller's LIMITS.perDay, so the numbers cannot drift.
  dailyBudget: Number(process.env.ZEN_DAILY_BUDGET || 700),
  rateWaitMaxMs: 0,
  timeoutMs: Number(process.env.ZEN_TIMEOUT_MS || 90_000),
});

async function call(path, body, timeoutMs = 30_000) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body is still worth logging */ }
  return { status: res.status, json, text: text.slice(0, 400) };
}

async function register() {
  const egress = process.env.ZEN_EGRESS_IP
    || await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10_000) }).then((r) => r.text()).catch(() => null);
  const res = await call('/zen/pool/register', {
    worker_id: workerId,
    repo: process.env.ZEN_POOL_REPO || process.env.GITHUB_REPOSITORY || '',
    run_id: process.env.GITHUB_RUN_ID || '',
    run_attempt: process.env.GITHUB_RUN_ATTEMPT || '',
    egress_ip: egress || null,
    runner_name: process.env.RUNNER_NAME || null,
    node: process.version,
    idle_exit_ms: args.idleExit,
  });
  if (res.status !== 200 || !res.json?.lease_id) {
    console.log('POOL_REGISTER_FAILED ' + JSON.stringify({ status: res.status, body: res.text }));
    process.exit(3);
  }
  return res.json;
}

async function pull(leaseId, holdMs) {
  const res = await fetch(`${base}/zen/pool/pull?lease=${encodeURIComponent(leaseId)}&hold_ms=${holdMs}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(holdMs + 15_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 204 has no body */ }
  return { status: res.status, json };
}

async function serve(task) {
  const started = Date.now();
  mark('task_claimed', { task_id: task.id, model: task.model, wait_ms: task.wait_ms });
  const res = await client.chat({
    model: task.model,
    messages: [{ role: 'user', content: task.prompt }],
    maxTokens: task.max_tokens || 300,
  });
  const text = res.ok ? String(res.message?.content ?? '').trim() : '';
  const record = {
    ok: !!res.ok && text.length > 0,
    model: task.model,
    prompt: task.prompt,
    text,
    kind: res.ok ? 'ok' : res.kind,
    stopped_by: res.ok ? null : (res.stopped_by || null),
    status: res.status ?? null,
    error: res.ok ? null : String(res.error || res.bodySnippet || '').slice(0, 500),
    provider_ms: res.ms ?? null,
    served_ms: Date.now() - started,
    runner: {
      run_id: process.env.GITHUB_RUN_ID || null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
      runner_name: process.env.RUNNER_NAME || null,
      egress_ip: process.env.ZEN_EGRESS_IP || null,
    },
    marks,
    served_at: iso(),
  };
  if (args.out) writeFileSync(args.out, JSON.stringify(record, null, 2));
  console.log('POOL_SERVE_RESULT ' + JSON.stringify({
    task_id: task.id, ok: record.ok, model: record.model, kind: record.kind,
    status: record.status, provider_ms: record.provider_ms, served_ms: record.served_ms,
    chars: text.length, text: text.slice(0, 800), error: record.error,
  }));
  const posted = await call('/zen/pool/result', {
    task_id: task.id, ok: record.ok, text, kind: record.kind, error: record.error,
    provider_ms: record.provider_ms, served_ms: record.served_ms,
    stopped_by: record.stopped_by || null,
  });
  mark('result_posted', { task_id: task.id, status: posted.status, rotate: posted.json?.rotate === true });
  record.rotate = posted.json?.rotate === true;
  return record;
}

const lease = await register();
mark('registered', { lease_id: lease.lease_id, pull_hold_ms: lease.pull_hold_ms, idle_exit_ms: lease.idle_exit_ms, workers_live: lease.workers_live });

let served = 0;
for (;;) {
  const p = await pull(lease.lease_id, lease.pull_hold_ms);
  if (p.status === 200 && p.json?.bye) {
    console.log('POOL_EXIT ' + JSON.stringify({ reason: p.json.reason, served }));
    process.exit(0);
  }
  if (p.status === 200 && p.json?.task) {
    const record = await serve(p.json.task);
    served += 1;
    if (!record.ok) process.exitCode = 2;
    // The quota on this run's egress address is gone (~1000 requests per IP per model, measured).
    // A new run boots on a new address with a full quota, so leaving now is the recovery — and
    // staying would mean claiming every queued task and failing it against a dark address until
    // midnight UTC. `bye` is what the hub answered with; a local kind check covers an older hub.
    const spent = record.rotate === true || record.kind === 'daily' || record.kind === 'provider' || record.kind === 'rate';
    if (spent) {
      console.log('POOL_ROTATE ' + JSON.stringify({
        reason: 'address_quota_spent', kind: record.kind, served,
        egress_ip: process.env.ZEN_EGRESS_IP || null, retry: 'boot a new run (new egress IP)',
      }));
      console.log('POOL_EXIT ' + JSON.stringify({ reason: 'address_quota_spent', served }));
      process.exit(2);
    }
    if (args.maxTasks > 0 && served >= args.maxTasks) {
      console.log('POOL_EXIT ' + JSON.stringify({ reason: 'max_tasks', served }));
      process.exit(record.ok ? 0 : 2);
    }
    continue;
  }
  if (p.status === 401 || p.status === 403) {
    console.log('POOL_AUTH_FAILED ' + JSON.stringify({ status: p.status }));
    process.exit(3);
  }
  if (p.status !== 204) {
    console.log('POOL_PULL_UNEXPECTED ' + JSON.stringify({ status: p.status, body: (p.json ? JSON.stringify(p.json) : '').slice(0, 200) }));
  }
}
