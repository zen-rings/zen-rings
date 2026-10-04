#!/usr/bin/env node
// zen-pool-smoke — the whole protocol in one run, on a real runner.
//
// The owner asked to «затестить общую рабочую логику». That is exactly this file: it proves, in one
// pass and with live provider calls, the five things the design claims.
//
//   1. a job registers itself and appears in /zen/pool/health;
//   2. one POST /zen/pool/invoke returns the ANSWER TEXT inside that same HTTP response;
//   3. the SAME job serves a second call — the fast path, with no boot in between;
//   4. a caller-supplied watchdog fires on a slow model (504 + task_id) and the late answer is
//      still picked up by task_id, so a timeout never loses the work;
//   5. /zen/pool/stop makes the job exit by itself on its next pull.
//
// Exit 0 only when steps 1-4 all produced real text; a green run must never mean "nothing ran".

const base = (process.env.ZEN_RUNNER_URL || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
const token = String(process.env.ZEN_RUNNER_TOKEN || '').trim();
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const out = [];
const say = (line) => { console.log(line); out.push(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which model to use is decided from the live table, not from a constant: the whole point of the
// quarantine is that any given model may be silent today, and a smoke test that hardcodes one would
// fail for a reason that has nothing to do with the pool.
const table = await fetch(`${base}/zen/models`, { headers }).then((r) => r.json()).catch(() => null);
const byModel = new Map((table?.models || []).map((m) => [m.model, m]));
// Candidates in order of how recently they were seen answering. A model that is NOT in the table
// has never been judged, so its verdict is 'run' by definition — that is how nemotron-3-ultra-free
// answered earlier today while every model IN the table was in quarantine.
// space-bunny-free first: verified answering 200 from a plain client just now, while
// longcat-2.5-preview / mimo-v2.5 / ling-3.1 all refuse with the 403 fingerprint error.
// 'down' means the provider is broken and silence is the right answer — skip those. 'ok' + 'skip'
// only means "the self-test should not re-probe it for 6h", which says nothing about whether a
// explicit call works, and the pool no longer lets the quarantine refuse one.
const CANDIDATES = ['space-bunny-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'mimo-v2.6-flash-free'];
const FAST = CANDIDATES.find((m) => byModel.get(m)?.status !== 'down') || null;
const SLOW = FAST;

if (!token) { say('SMOKE_FAIL missing ZEN_RUNNER_TOKEN'); process.exit(3); }

const health = () => fetch(`${base}/zen/pool/health`).then((r) => r.json()).catch(() => null);

async function waitForWorker(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await health();
    if (h?.workers_live > 0) return h;
    if (Date.now() > deadline) return h;
    await sleep(3000);
  }
}

async function invoke(model, prompt, waitMs) {
  const sent = Date.now();
  const res = await fetch(`${base}/zen/pool/invoke`, {
    method: 'POST', headers,
    body: JSON.stringify({ model, prompt, max_tokens: 200, wait_ms: waitMs }),
  });
  const body = await res.json().catch(() => ({}));
  return { http: res.status, elapsed_ms: Date.now() - sent, body };
}

const check = [];
function record(name, ok, detail) {
  check.push({ name, ok });
  say(`SMOKE ${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
}

// 1 — a job is there
const h = await waitForWorker();
record('warm_job_registered', h?.workers_live > 0, { workers_live: h?.workers_live ?? null, workers: h?.workers ?? null });

// 2 — one call, answer text inside the response
if (!FAST) { say('SMOKE_FAIL every candidate model is down'); say('SMOKE_SUMMARY ' + JSON.stringify({ total: 5, failed: 5 })); process.exit(2); }
say('SMOKE_MODELS ' + JSON.stringify({ chosen: FAST, table: (table?.models || []).map((m) => `${m.model}:${m.status}:${m.verdict}`) }));

const c1 = await invoke(FAST, 'Answer in one short sentence: what is 2+4?', 30_000);
record('answer_text_in_response', c1.http === 200 && !!c1.body.text, {
  http: c1.http, elapsed_ms: c1.elapsed_ms, served_ms: c1.body.served_ms, provider_ms: c1.body.provider_ms,
  worker_id: c1.body.worker_id, text: (c1.body.text || '').slice(0, 200), error: c1.body.error || null,
});

// 3 — the SAME job, second call, no boot in between
const c2 = await invoke(FAST, 'Answer in one short sentence: what is the capital of France?', 30_000);
record('second_call_same_job', c2.http === 200 && !!c2.body.text && c2.body.worker_id === c1.body.worker_id, {
  http: c2.http, elapsed_ms: c2.elapsed_ms, served_ms: c2.body.served_ms, worker_id: c2.body.worker_id,
  same_worker: c2.body.worker_id === c1.body.worker_id, text: (c2.body.text || '').slice(0, 200),
  boot_cost_avoided_ms: Math.max(0, c2.elapsed_ms - (c2.body.served_ms || c2.elapsed_ms)),
});

// 4 — the caller's watchdog fires, the answer still arrives
// The watchdog test needs an answer that takes longer than the caller's 2 s. Rather than betting
// on one slow model, ask for a long generation on whatever model is alive — a 400-token essay
// costs seconds on any of them, and the point is the TIMING, not the model.
const slow = await invoke(SLOW, 'Write a 400-word essay about the history of the Roman Empire.', 2000);
let late = null;
if (slow.http === 504 && slow.body.task_id) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    await sleep(3000);
    const r = await fetch(`${base}/zen/pool/result/${slow.body.task_id}`, { headers });
    const j = await r.json().catch(() => ({}));
    if (j.state === 'done') { late = j; break; }
    if (Date.now() > deadline) break;
  }
}
record('watchdog_504_then_late_answer', slow.http === 504 && !!late?.text, {
  watchdog_http: slow.http, wait_ms: slow.body.wait_ms, fired_after_ms: slow.elapsed_ms, task_id: slow.body.task_id,
  late_text: (late?.text || '').slice(0, 200), late_served_ms: late?.served_ms ?? null,
  late_provider_ms: late?.provider_ms ?? null,
});

// 5 — the job is told to stop and exits by itself
const workerId = c1.body.worker_id || h?.workers?.[0]?.worker_id;
let stopped = null;
if (workerId) {
  const res = await fetch(`${base}/zen/pool/stop`, { method: 'POST', headers, body: JSON.stringify({ worker_id: workerId }) });
  stopped = await res.json().catch(() => null);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const after = await health();
    if ((after?.workers_live ?? 0) === 0 || Date.now() > deadline) { stopped = { ...(stopped || {}), workers_live_after: after?.workers_live ?? null }; break; }
    await sleep(3000);
  }
}
record('job_exits_on_stop', stopped?.stopped === true && stopped?.workers_live_after === 0, stopped);

const failed = check.filter((c) => !c.ok);
say('SMOKE_SUMMARY ' + JSON.stringify({ total: check.length, failed: failed.length, checks: check }));
process.exit(failed.length ? 2 : 0);