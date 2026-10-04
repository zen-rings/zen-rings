// Zen Pool — a long-lived GitHub Actions job that behaves like an API.
//
// Why this exists: a GitHub-hosted runner has no inbound address (measured — nothing is handed
// back at dispatch time), so "one dispatch per answer" pays a full cold start (~10-13 s measured)
// for every single call. Here ONE job boots, registers itself, and then holds a long-poll open.
// The caller POSTs a task and gets the answer back inside the same HTTP request: no new job, no
// new boot, no log scraping.
//
// The watchdog is the CALLER's, not ours: `wait_ms` says how long the caller is willing to wait
// for an answer. Default 30 s (the owner's number), clamped to [1 s, 90 s] — the ceiling is the
// edge's idle timeout, anything longer must be picked up with GET /zen/pool/result/{id}.
//
// Dependency-free of the Workerd runtime (same rule as handler.js) so `node --test` runs it.

import { applyReport, budgetVerdict, LIMITS, readModel, writeModel, bumpCount, readCounts, authorized } from './zen-runner.js';

export const DEFAULT_WAIT_MS = 30_000;   // the owner's default watchdog
export const MIN_WAIT_MS = 1_000;
export const MAX_WAIT_MS = 90_000;      // under the edge's idle timeout; longer = poll the result
export const DEFAULT_PULL_HOLD_MS = 20_000;  // how long one pull stays open before it re-polls
export const MIN_PULL_HOLD_MS = 5_000;
export const MAX_PULL_HOLD_MS = 25_000;
export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;  // a job with no work for this long exits itself
export const LEASE_TTL_MS = 90_000;     // a job that stops pulling is dead after this
export const ORPHAN_TASK_MS = 120_000;  // a claimed task with no answer for this long is requeued
const POLL_STEP_MS = 200;               // first look at the task row after a dispatch
// A 30 s wait is ~50 looks, not ~150: the step grows because the answer itself takes seconds
// (TTFT measured 0.4-3.4 s), and every loop iteration costs CPU against the Worker's CPU limit.
const backoffMs = (i) => Math.min(Math.round(POLL_STEP_MS * 1.6 ** i), 1000);
const BODY_MAX_BYTES = 8 * 1024;
const MODEL_RE = /^[A-Za-z0-9._:@/-]{1,120}$/;

// 204/304 must carry a null body — `new Response('', {status:204})` throws in undici.
const j = (status, obj, headers = {}) =>
  status === 204 || status === 304
    ? new Response(null, { status, headers })
    : new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = (env) => Number(env.ZEN_NOW_MS) || Date.now();

// ---------------------------------------------------------------- pure logic (unit-tested)

export function clampWaitMs(value, { def = DEFAULT_WAIT_MS, min = MIN_WAIT_MS, max = MAX_WAIT_MS } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.round(n), min), max);
}

export function clampPullHoldMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PULL_HOLD_MS;
  return Math.min(Math.max(Math.round(n), MIN_PULL_HOLD_MS), MAX_PULL_HOLD_MS);
}

// What a pull should do next. `task` is the claimed task, if one was available.
export function pullDecision({ leaseValid, stopRequested, idleMs, idleExitMs, task = null }) {
  // stop first: a job that was told to stop must hear THAT, not the vaguer "your lease is gone".
  if (stopRequested) return { action: 'exit', reason: 'stop_requested' };
  if (!leaseValid) return { action: 'exit', reason: 'lease_expired' };
  if (task) return { action: 'task', task };
  if (idleMs >= idleExitMs) return { action: 'exit', reason: 'idle_ttl' };
  return { action: 'wait' };
}

export function leaseExpired(row, now) {
  return !row || now > Number(row.lease_expires_at || 0);
}

// A lease is usable only while the job is live AND has not gone silent: a job that died without
// saying goodbye simply stops renewing, and this is what drops it out of the pool.
export function leaseUsable(row, now) {
  return !!row && row.state === 'live' && !leaseExpired(row, now);
}

// ---------------------------------------------------------------- D1 helpers

const db = (env) => env.ZEN_DB;

async function readTask(env, id) {
  return await db(env).prepare('SELECT * FROM zen_pool_tasks WHERE id = ?1').bind(id).first();
}

async function readLiveWorkers(env, now) {
  return (await db(env).prepare(
    'SELECT * FROM zen_pool_workers WHERE state = ?1 AND lease_expires_at > ?2 ORDER BY last_seen_at DESC'
  ).bind('live', now).all()).results || [];
}

// Claim the oldest queued task. The `state='queued'` guard in the UPDATE is what makes two
// pollers racing for the same task safe: exactly one of them sees changes = 1.
async function claimTask(env, workerId, leaseId, now) {
  await db(env).prepare(
    'UPDATE zen_pool_tasks SET state = ?1, worker_id = NULL, lease_id = NULL WHERE state = ?2 AND claimed_at < ?3'
  ).bind('queued', 'claimed', now - ORPHAN_TASK_MS).run();
  const row = await db(env).prepare(
    'SELECT id FROM zen_pool_tasks WHERE state = ?1 ORDER BY enqueued_at LIMIT 1'
  ).bind('queued').first();
  if (!row) return null;
  const res = await db(env).prepare(
    'UPDATE zen_pool_tasks SET state = ?1, worker_id = ?2, lease_id = ?3, claimed_at = ?4 WHERE id = ?5 AND state = ?6'
  ).bind('claimed', workerId, leaseId, now, row.id, 'queued').run();
  if (!res?.meta?.changes) return null;
  return await readTask(env, row.id);
}

async function writeResult(env, task, body, now) {
  await db(env).prepare(
    `UPDATE zen_pool_tasks SET state = ?1, ok = ?2, text = ?3, kind = ?4, error = ?5,
       provider_ms = ?6, served_ms = ?7, finished_at = ?8
     WHERE id = ?9`
  ).bind(
    body.ok ? 'done' : 'failed', body.ok ? 1 : 0,
    body.ok ? String(body.text || '').slice(0, 8000) : null,
    body.ok ? 'ok' : String(body.kind || 'error').slice(0, 40),
    body.ok ? null : String(body.error || '').slice(0, 500),
    Number(body.provider_ms) || null, Number(body.served_ms) || null, now, task.id,
  ).run();
  await db(env).prepare('UPDATE zen_pool_workers SET tasks_served = tasks_served + 1, last_seen_at = ?1 WHERE id = ?2')
    .bind(now, task.lease_id).run();
}

// ---------------------------------------------------------------- routes

// POST /zen/pool/register — the job announces itself and gets a lease.
export async function zenPoolRegister(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const now = nowMs(env);
  const workerId = String(body.worker_id || '').slice(0, 160);
  if (!workerId) return j(400, { error: 'worker_id is required (repo:run:attempt)' });
  const leaseId = crypto.randomUUID();
  const idleExit = Math.min(Math.max(Number(body.idle_exit_ms) || DEFAULT_IDLE_EXIT_MS, 60_000), 6 * 3_600_000);
  await db(env).prepare(
    `INSERT INTO zen_pool_workers (id, worker_id, repo, run_id, run_attempt, egress_ip, runner_name, node,
       state, tasks_served, idle_exit_ms, lease_expires_at, registered_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'live', 0, ?9, ?10, ?11, ?11)
     ON CONFLICT(id) DO UPDATE SET state='live', tasks_served=0, lease_expires_at=?10, last_seen_at=?11`
  ).bind(leaseId, workerId, String(body.repo || '').slice(0, 120), String(body.run_id || '').slice(0, 80),
    String(body.run_attempt || '').slice(0, 20), String(body.egress_ip || '').slice(0, 64),
    String(body.runner_name || '').slice(0, 120), String(body.node || '').slice(0, 40),
    idleExit, now + LEASE_TTL_MS, now).run();
  const live = await readLiveWorkers(env, now);
  return j(200, {
    lease_id: leaseId,
    lease_expires_in_ms: LEASE_TTL_MS,
    pull_hold_ms: clampPullHoldMs(body.pull_hold_ms),
    idle_exit_ms: idleExit,
    poll_step_ms: POLL_STEP_MS,
    workers_live: live.length,
    worker_ids: live.map((w) => w.worker_id),
  });
}

// GET /zen/pool/pull?lease=… — long-poll. 200 {task} | 200 {bye} | 204 (nothing yet).
export async function zenPoolPull(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const url = new URL(request.url);
  const leaseId = String(url.searchParams.get('lease') || '');
  if (!leaseId) return j(400, { error: 'lease is required' });
  const hold = clampPullHoldMs(url.searchParams.get('hold_ms'));
  const now = nowMs(env);
  const row = await db(env).prepare('SELECT * FROM zen_pool_workers WHERE id = ?1').bind(leaseId).first();
  if (leaseExpired(row, now)) {
    return j(200, { bye: true, reason: 'lease_expired', hint: 'register again' });
  }
  const deadline = Date.now() + hold;
  let step = 0;
  for (;;) {
    const t = nowMs(env);
    await db(env).prepare('UPDATE zen_pool_workers SET lease_expires_at = ?1, last_seen_at = ?2 WHERE id = ?3')
      .bind(t + LEASE_TTL_MS, t, leaseId).run();
    const task = await claimTask(env, row.worker_id, leaseId, t);
    const fresh = await db(env).prepare('SELECT * FROM zen_pool_workers WHERE id = ?1').bind(leaseId).first();
    const decision = pullDecision({
      leaseValid: leaseUsable(fresh, t),
      stopRequested: fresh.state !== 'live',
      idleMs: t - Number(fresh.registered_at || t),
      idleExitMs: Number(fresh.idle_exit_ms || DEFAULT_IDLE_EXIT_MS),
      task,
    });
    if (decision.action === 'task') return j(200, { task: taskRow(decision.task) });
    if (decision.action === 'exit') {
      await db(env).prepare('UPDATE zen_pool_workers SET state = ?1, stop_reason = ?2, exited_at = ?3 WHERE id = ?4')
        .bind('gone', decision.reason, t, leaseId).run();
      return j(200, { bye: true, reason: decision.reason });
    }
    if (Date.now() >= deadline) return j(204, {});
    await sleep(backoffMs(step++));
  }
}

// POST /zen/pool/result — the answer, and the only way the quarantine learns anything.
export async function zenPoolResult(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const taskId = String(body.task_id || '').slice(0, 80);
  if (!taskId) return j(400, { error: 'task_id is required' });
  const task = await readTask(env, taskId);
  if (!task) return j(404, { error: 'unknown task' });
  if (task.state !== 'claimed') return j(409, { error: `task is ${task.state}, not claimed` });
  const now = nowMs(env);
  await writeResult(env, task, body, now);
  const state = applyReport(await readModel(env, task.model), { ok: !!body.ok, kind: body.kind, error: body.error }, now);
  await writeModel(env, task.model, state);
  return j(200, { accepted: true, task_id: taskId, state: state.status, next_check_in: Math.max(0, state.next_check_at - now) });
}

// POST /zen/pool/stop — "а потом её убиваем": the next pull says bye and the job exits cleanly.
export async function zenPoolStop(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const workerId = String(body.worker_id || '').slice(0, 160);
  if (!workerId) return j(400, { error: 'worker_id is required' });
  const now = nowMs(env);
  const res = await db(env).prepare(
    "UPDATE zen_pool_workers SET state = 'stopping', stop_reason = 'stop_requested' WHERE worker_id = ?1 AND state = 'live'"
  ).bind(workerId).run();
  return j(200, { ok: true, stopped: !!res?.meta?.changes, worker_id: workerId });
}

// POST /zen/pool/invoke {model, prompt, max_tokens?, wait_ms?} — the whole point: one HTTP call,
// one answer, no job per call. 200 {text} | 504 {task_id} (answer still lands, fetch it) |
// 503 (no warm worker) | 409 (quarantine) | 429 (budget).
export async function zenPoolInvoke(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > BODY_MAX_BYTES) return j(413, { error: 'body too large' });
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const model = String(body.model || '');
  if (!MODEL_RE.test(model)) return j(400, { error: 'model is required (explicit id)' });
  const prompt = String(body.prompt ?? '');
  if (!prompt.trim()) return j(400, { error: 'prompt is required' });
  const waitMs = clampWaitMs(body.wait_ms);
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 300, 1), 4096);
  const now = nowMs(env);

  const state = await readModel(env, model);
  if (state && state.next_check_at > now) {
    return j(409, { error: 'model is in quarantine', status: state.status, next_check_at: state.next_check_at,
      retry_after: state.next_check_at - now });
  }
  const workers = await readLiveWorkers(env, now);
  if (!workers.length) {
    return j(503, { error: 'no warm runner', hint: 'dispatch zen-pool.yml in a ring repository, or use POST /zen/run for a cold dispatch' });
  }
  const perRepo = budgetVerdict(await readCounts(env, workers[0].repo, model), now,
    { perMin: Number(env.ZEN_PER_MIN) || LIMITS.perMin, perDay: Number(env.ZEN_PER_DAY) || LIMITS.perDay });
  const perAll = budgetVerdict(await readCounts(env, '*', '*'), now,
    { perMin: Number(env.ZEN_PER_MIN) || LIMITS.perMin, perDay: Number(env.ZEN_PER_DAY) || LIMITS.perDay });
  for (const v of [perRepo, perAll]) {
    if (!v.ok) return j(429, { error: `budget exhausted (${v.reason})`, reason: v.reason, retry_after: v.retry_after });
  }

  const id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  await db(env).prepare(
    'INSERT INTO zen_pool_tasks (id, model, prompt, max_tokens, wait_ms, state, enqueued_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  ).bind(id, model, prompt.slice(0, 4000), maxTokens, waitMs, 'queued', now).run();
  await bumpCount(env, workers[0].repo, model, now);
  await bumpCount(env, '*', '*', now);

  const deadline = Date.now() + waitMs;
  let step = 0;
  for (;;) {
    const row = await readTask(env, id);
    if (row.state === 'done' || row.state === 'failed') {
      return j(row.state === 'done' ? 200 : 502, {
        task_id: id, model, ok: !!row.ok, text: row.text || null, kind: row.kind,
        error: row.error, provider_ms: row.provider_ms, served_ms: row.served_ms,
        worker_id: row.worker_id, wait_ms: waitMs,
      });
    }
    if (Date.now() >= deadline) {
      await db(env).prepare('UPDATE zen_pool_tasks SET wait_returned_at = ?1 WHERE id = ?2').bind(nowMs(env), id).run();
      return j(504, { error: 'watchdog fired before the answer arrived', task_id: id, wait_ms: waitMs,
        hint: 'the job is still working — GET /zen/pool/result/{task_id} picks the answer up' });
    }
    await sleep(backoffMs(step++));
  }
}

// GET /zen/pool/result/{task_id} — the answer whenever it lands, including after a 504.
export async function zenPoolResultById(request, env, taskId) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const row = await readTask(env, String(taskId || ''));
  if (!row) return j(404, { error: 'unknown task' });
  return j(200, {
    task_id: row.id, model: row.model, state: row.state, ok: row.ok, text: row.text || null,
    kind: row.kind, error: row.error, provider_ms: row.provider_ms, served_ms: row.served_ms,
    worker_id: row.worker_id, wait_ms: row.wait_ms, enqueued_at: row.enqueued_at,
    claimed_at: row.claimed_at, finished_at: row.finished_at, wait_returned_at: row.wait_returned_at,
  });
}

// GET /zen/pool/health — how many jobs are live right now (no auth, like /zen/health).
export async function zenPoolHealth(request, env) {
  const now = nowMs(env);
  const out = { service: 'zen-pool', ok: !!env.ZEN_DB, workers_live: 0, workers: [], queued: 0, default_wait_ms: DEFAULT_WAIT_MS };
  if (env.ZEN_DB) {
    try {
      out.workers = (await readLiveWorkers(env, now)).map((w) => ({
        worker_id: w.worker_id, repo: w.repo, egress_ip: w.egress_ip, tasks_served: w.tasks_served,
        idle_for_ms: now - Number(w.registered_at || now), lease_expires_in_ms: Number(w.lease_expires_at) - now,
      }));
      out.workers_live = out.workers.length;
      out.queued = (await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_tasks WHERE state = ?1').bind('queued').first())?.n ?? 0;
    } catch (e) { out.error = String(e?.message || e).slice(0, 120); }
  }
  return j(200, out);
}

function taskRow(t) {
  return { id: t.id, model: t.model, prompt: t.prompt, max_tokens: t.max_tokens, wait_ms: t.wait_ms, enqueued_at: t.enqueued_at };
}
