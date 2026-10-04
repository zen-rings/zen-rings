import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';
import {
  clampWaitMs, clampPullHoldMs, pullDecision, leaseExpired, leaseUsable,
  lambdaPerMin, inflightFrom, desiredWorkers, scaleDecision, shouldRotateOnResult, shouldRotateOnLocalStop,
  DEFAULT_WAIT_MS, MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_PULL_HOLD_MS,
  POOL_CEILING, POOL_RESERVE, POOL_TTL_MS, SERVICE_MS_DEFAULT, BOOT_MS,
} from '../src/zen-pool.js';

const ENV = { ZEN_RUNNER_TOKEN: 'zen-tok' };
const NOW = Date.UTC(2026, 9, 4, 10, 0, 0);
const auth = { authorization: 'Bearer zen-tok' };

// In-memory D1 double for the pool tables (plus the model/budget rows the invoke path touches).
// The claim UPDATE is guarded by `state='queued'` exactly like the real statement, so a racing
// poller that loses the race sees changes = 0 and gets no task.
function fakeD1(seed = {}) {
  const workers = new Map();
  const tasks = new Map();
  const models = new Map((seed.models || []).map((m) => [m.model, m]));
  const budget = new Map((seed.budget || []).map((b) => [`${b.scope}|${b.model}`, b]));
  const repos = new Map((seed.repos || []).map((r) => [r.repo, { enabled: 1, location: '', ...r }]));
  const dispatches = new Map();
  const meta = new Map(Object.entries(seed.meta || {}));

  const api = {
    _workers: workers, _tasks: tasks, _models: models, _budget: budget,
    _repos: repos, _dispatches: dispatches, _meta: meta,
    prepare(sql) {
      let bound = [];
      const stmt = {
        first: async () => first(sql, bound),
        all: async () => ({ results: all(sql, bound) }),
        run: async () => { return run_(sql, bound); },
        bind(...p) { bound = p; return stmt; },
      };
      return stmt;
    },
  };

  function first(sql, p) {
    if (/FROM zen_pool_workers WHERE id = \?1/.test(sql)) return workers.get(p[0]) || null;
    if (/FROM zen_pool_tasks WHERE id = \?1/.test(sql)) return tasks.get(p[0]) || null;
    if (/SELECT id FROM zen_pool_tasks WHERE state/.test(sql)) {
      const q = [...tasks.values()].filter((t) => t.state === p[0]).sort((a, b) => a.enqueued_at - b.enqueued_at)[0];
      return q ? { id: q.id } : null;
    }
    if (/FROM zen_models WHERE model = \?1/.test(sql)) return models.get(p[0]) || null;
    if (/FROM zen_budget WHERE scope/.test(sql)) return budget.get(`${p[0]}|${p[1]}`) || null;
    if (/COUNT\(\*\) AS n FROM zen_pool_tasks WHERE state/.test(sql)) return { n: [...tasks.values()].filter((t) => t.state === p[0]).length };
    if (/COUNT\(\*\) AS n FROM zen_pool_tasks WHERE enqueued_at/.test(sql)) return { n: [...tasks.values()].filter((t) => t.enqueued_at > p[0]).length };
    if (/COUNT\(\*\) AS n FROM zen_pool_dispatches/.test(sql)) return { n: [...dispatches.values()].filter((d) => d.requested_at > p[0]).length };
    if (/COUNT\(\*\) AS n FROM zen_pool_workers WHERE registered_at/.test(sql)) return { n: [...workers.values()].filter((w) => w.registered_at > p[0]).length };
    if (/FROM zen_meta WHERE k = \?1/.test(sql)) { const v = meta.get(p[0]); return v === undefined ? null : { v }; }
    return null;
  }
  function all(sql, p) {
    if (/FROM zen_pool_workers WHERE state = \?1 AND lease_expires_at/.test(sql)) {
      return [...workers.values()].filter((w) => w.state === p[0] && w.lease_expires_at > p[1]);
    }
    if (/FROM zen_repos WHERE enabled = 1/.test(sql)) return [...repos.values()].filter((r) => r.enabled);
    if (/FROM zen_pool_dispatches ORDER BY requested_at DESC/.test(sql)) {
      return [...dispatches.values()].sort((a, b) => b.requested_at - a.requested_at).slice(0, p[0]);
    }
    return [];
  }
  function run_(sql, p) {
    if (/INSERT INTO zen_pool_workers/.test(sql)) {
      const [id, workerId, repo, runId, attempt, egress, runner, node, idleExit, leaseExp, now] = p;
      workers.set(id, {
        id, worker_id: workerId, repo, run_id: runId, run_attempt: attempt, egress_ip: egress,
        runner_name: runner, node, state: 'live', tasks_served: 0, idle_exit_ms: idleExit,
        lease_expires_at: leaseExp, registered_at: now, last_seen_at: now,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/UPDATE zen_pool_workers SET lease_expires_at/.test(sql)) {
      const w = workers.get(p[2]); if (w) { w.lease_expires_at = p[0]; w.last_seen_at = p[1]; }
      return { success: true, meta: { changes: w ? 1 : 0 } };
    }
    if (/UPDATE zen_pool_workers SET state = \?1, stop_reason/.test(sql)) {
      const w = workers.get(p[3]); if (w) { w.state = p[0]; w.stop_reason = p[1]; w.exited_at = p[2]; }
      return { success: true, meta: { changes: w ? 1 : 0 } };
    }
    if (/UPDATE zen_pool_workers SET tasks_served/.test(sql)) {
      const w = workers.get(p[1]); if (w) { w.tasks_served += 1; w.last_seen_at = p[0]; }
      return { success: true, meta: { changes: w ? 1 : 0 } };
    }
    if (/UPDATE zen_pool_workers SET state = 'stopping'/.test(sql)) {
      let n = 0;
      for (const w of workers.values()) if (w.worker_id === p[0] && w.state === 'live') { w.state = 'stopping'; n++; }
      return { success: true, meta: { changes: n } };
    }
    if (/UPDATE zen_pool_tasks SET state = \?1, worker_id = NULL/.test(sql)) {
      let n = 0;
      for (const t of tasks.values()) if (t.state === p[1] && t.claimed_at < p[2]) { t.state = p[0]; t.worker_id = null; t.lease_id = null; n++; }
      return { success: true, meta: { changes: n } };
    }
    if (/UPDATE zen_pool_tasks SET state = \?1, worker_id = \?2, lease_id = \?3, claimed_at/.test(sql)) {
      const t = tasks.get(p[4]);
      if (!t || t.state !== p[5]) return { success: true, meta: { changes: 0 } };
      t.state = p[0]; t.worker_id = p[1]; t.lease_id = p[2]; t.claimed_at = p[3];
      return { success: true, meta: { changes: 1 } };
    }
    if (/UPDATE zen_pool_tasks SET state = \?1, ok = \?2, text/.test(sql)) {
      const t = tasks.get(p[8]);
      if (t) { t.state = p[0]; t.ok = p[1]; t.text = p[2]; t.kind = p[3]; t.error = p[4]; t.provider_ms = p[5]; t.served_ms = p[6]; t.finished_at = p[7]; }
      return { success: true, meta: { changes: t ? 1 : 0 } };
    }
    if (/INSERT INTO zen_pool_tasks/.test(sql)) {
      const [id, model, prompt, maxTokens, waitMs, state, enqueued] = p;
      tasks.set(id, { id, model, prompt, max_tokens: maxTokens, wait_ms: waitMs, state, enqueued_at: enqueued });
      return { success: true, meta: { changes: 1 } };
    }
    if (/UPDATE zen_pool_tasks SET wait_returned_at/.test(sql)) {
      const t = tasks.get(p[1]); if (t) t.wait_returned_at = p[0];
      return { success: true, meta: { changes: t ? 1 : 0 } };
    }
    if (/INSERT INTO zen_models/.test(sql)) {
      const [model, status, failures, successes, err, kind, okAt, firstFailed, next, updated] = p;
      models.set(model, { model, status, failures, successes, last_error: err, last_error_kind: kind,
        last_ok_at: okAt, first_failed_at: firstFailed, next_check_at: next, updated_at: updated });
      return { success: true, meta: { changes: 1 } };
    }
    if (/INSERT INTO zen_budget/.test(sql)) {
      const [scope, model, now, d] = p;
      const prev = budget.get(`${scope}|${model}`);
      const freshMin = prev && now - prev.minute_at < 60_000;
      const sameDay = prev && prev.day === d;
      budget.set(`${scope}|${model}`, {
        scope, model,
        minute_count: freshMin ? prev.minute_count + 1 : 1,
        minute_at: freshMin ? prev.minute_at : now,
        day_count: sameDay ? prev.day_count + 1 : 1,
        day: d,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/INSERT INTO zen_pool_dispatches/.test(sql)) {
      const [id, repo, reason, requestedAt, state] = p;
      dispatches.set(id, { id, repo, reason, requested_at: requestedAt, worker_id: null, state });
      return { success: true, meta: { changes: 1 } };
    }
    if (/INSERT INTO zen_meta/.test(sql)) {
      meta.set(p[0], p[1]);
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
  return api;
}

const env = (d1, extra = {}) => ({ ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, ...extra });
const post = (path, body, d1, extra = {}) =>
  handle(new Request(`https://l.test${path}`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1, extra));
const get = (path, d1, headers = auth) =>
  handle(new Request(`https://l.test${path}`, { headers }), env(d1));

test('rotation rule: only a spent address rotates; a transient one keeps the worker', () => {
  // daily = the ~1000-request per-IP quota is gone, provider = the bare 429 burst wall,
  // rate = the same wall without the provider marker. All three mean "this address is done".
  for (const kind of ['daily', 'provider', 'rate']) assert.equal(shouldRotateOnResult(kind), true);
  // timeout/error/context are transient or local: the address is still good, the worker stays.
  for (const kind of ['timeout', 'error', 'context', 'fingerprint', 'cooldown']) assert.equal(shouldRotateOnResult(kind), false);
  assert.equal(shouldRotateOnResult(null), false);
  assert.equal(shouldRotateOnLocalStop('local-budget'), true);
  assert.equal(shouldRotateOnLocalStop('local-rate'), false);
  assert.equal(shouldRotateOnLocalStop(null), false);
});

test('watchdog: default 30 s, caller-supplied, clamped to [1 s, 90 s]', () => {
  assert.equal(clampWaitMs(undefined), DEFAULT_WAIT_MS);
  assert.equal(DEFAULT_WAIT_MS, 30_000);
  assert.equal(clampWaitMs(500), MIN_WAIT_MS);
  assert.equal(clampWaitMs(600_000), MAX_WAIT_MS);
  assert.equal(clampWaitMs(45_000), 45_000);
  assert.equal(clampWaitMs('nonsense'), DEFAULT_WAIT_MS);
  assert.equal(clampPullHoldMs(undefined), DEFAULT_PULL_HOLD_MS);
  assert.equal(clampPullHoldMs(10), 5_000);
  assert.equal(clampPullHoldMs(999_999), 25_000);
});

test('pull decision: task wins, then stop, then idle, then wait, then a dead lease exits', () => {
  const task = { id: 't1' };
  assert.deepEqual(pullDecision({ leaseValid: true, stopRequested: false, idleMs: 0, idleExitMs: 600_000, task }),
    { action: 'task', task });
  assert.deepEqual(pullDecision({ leaseValid: true, stopRequested: true, idleMs: 0, idleExitMs: 600_000, task: null }),
    { action: 'exit', reason: 'stop_requested' });
  assert.deepEqual(pullDecision({ leaseValid: false, stopRequested: true, idleMs: 0, idleExitMs: 600_000 }),
    { action: 'exit', reason: 'stop_requested' });
  assert.deepEqual(pullDecision({ leaseValid: true, stopRequested: false, idleMs: 601_000, idleExitMs: 600_000 }),
    { action: 'exit', reason: 'idle_ttl' });
  assert.deepEqual(pullDecision({ leaseValid: true, stopRequested: false, idleMs: 10, idleExitMs: 600_000 }),
    { action: 'wait' });
  assert.deepEqual(pullDecision({ leaseValid: false, stopRequested: false, idleMs: 0, idleExitMs: 600_000 }),
    { action: 'exit', reason: 'lease_expired' });
});

test('lease expiry: a job that stopped pulling is gone, a stopped one is not silently reused', () => {
  assert.equal(leaseExpired(null, NOW), true);
  assert.equal(leaseExpired({ state: 'live', lease_expires_at: NOW - 1 }, NOW), true);
  assert.equal(leaseExpired({ state: 'live', lease_expires_at: NOW + 1 }, NOW), false);
  assert.equal(leaseUsable({ state: 'live', lease_expires_at: NOW + 1 }, NOW), true);
  assert.equal(leaseUsable({ state: 'stopping', lease_expires_at: NOW + 1 }, NOW), false);
  assert.equal(leaseUsable({ state: 'live', lease_expires_at: NOW - 1 }, NOW), false);
});

test('register -> pull -> result -> invoke: one job serves a call and the answer comes back in the HTTP response', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:1:1', repo: 'vovalikessmoothy-png/LLM-test' }, d1);
  assert.equal(reg.status, 200);
  const lease = await reg.json();
  assert.ok(lease.lease_id);
  assert.equal(lease.pull_hold_ms, DEFAULT_PULL_HOLD_MS);

  // Nobody registered at all: the caller is told there is no warm runner instead of hanging.
  const empty = await post('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: '2+4?' }, fakeD1());
  assert.equal(empty.status, 503);
  assert.match((await empty.json()).error, /no warm runner/);

  // The caller's request stays open while the job pulls — that is the whole protocol.
  const pending = post('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: '2+4?' }, d1);
  await new Promise((r) => setTimeout(r, 50));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  assert.equal(pulled.status, 200);
  const task = (await pulled.json()).task;
  assert.equal(task.model, 'nemotron-3.5-lightning-free');

  const health = await get('/zen/pool/health', d1, {});
  assert.equal(health.status, 200);
  assert.equal((await health.json()).workers_live, 1);

  const res = await post('/zen/pool/result', { task_id: task.id, ok: true, text: 'six', provider_ms: 2100, served_ms: 2300 }, d1);
  assert.equal(res.status, 200);

  const again = await pending;
  assert.equal(again.status, 200);
  const body = await again.json();
  assert.equal(body.text, 'six');
  assert.equal(body.ok, true);
  assert.equal(body.wait_ms, DEFAULT_WAIT_MS);
  assert.equal(body.served_ms, 2300);
});

test('watchdog: a slow answer returns 504 with a task_id, and the late answer is still fetchable', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:2:1' }, d1);
  const lease = await reg.json();
  const pending = post('/zen/pool/invoke', { model: 'mimo-v2.6-flash-free', prompt: 'slow', wait_ms: 1000 }, d1);
  await new Promise((r) => setTimeout(r, 50));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;

  const timedOut = await pending;
  assert.equal(timedOut.status, 504);
  const body = await timedOut.json();
  assert.equal(body.wait_ms, 1000);
  assert.equal(body.task_id, task.id);

  const res = await post('/zen/pool/result', { task_id: task.id, ok: true, text: 'finally', provider_ms: 40000 }, d1);
  assert.equal(res.status, 200);
  const late = await get(`/zen/pool/result/${task.id}`, d1);
  assert.equal(late.status, 200);
  assert.equal((await late.json()).text, 'finally');
});

test('stop: POST /zen/pool/stop makes the next pull say bye, so the job exits instead of idling', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:3:1' }, d1);
  const lease = await reg.json();
  await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);

  const stop = await post('/zen/pool/stop', { worker_id: 'LLM-test:3:1' }, d1);
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).stopped, true);

  const after = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  assert.equal(after.status, 200);
  const bye = await after.json();
  assert.deepEqual(bye.bye, true);
  assert.equal(bye.reason, 'stop_requested');
});

test('an explicit call is NOT blocked by the quarantine — only the budget is', async () => {
  // The quarantine answers "should we probe this model on a schedule", not "a caller named it
  // explicitly". Blocking the second call to a model that just answered is what made the live
  // smoke fail: one success put the model in `skip` for 6h and the pool refused the next call.
  const d1 = fakeD1({ models: [{ model: 'jev-1.13-free', status: 'down', failures: 5, next_check_at: NOW + 3_600_000 }] });
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:4:1' }, d1);
  const lease = await reg.json();
  await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const q = await post('/zen/pool/invoke', { model: 'jev-1.13-free', prompt: 'x', wait_ms: 1000 }, d1);
  assert.equal(q.status, 504);   // accepted and waiting — NOT 409

  const full = fakeD1({ budget: [{ scope: '*', model: '*', minute_count: 50, minute_at: NOW, day_count: 1, day: '2026-10-04' }] });

  const reg2 = await post('/zen/pool/register', { worker_id: 'LLM-test:5:1' }, full);
  await get(`/zen/pool/pull?lease=${(await reg2.json()).lease_id}&hold_ms=5000`, full);
  const b = await post('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: 'x' }, full);
  assert.equal(b.status, 429);
  assert.match((await b.json()).error, /budget/);
});

// ---- autoscaling (Ф8: scale up the moment the queue is not empty) -----------------------------

test('lambda: arrivals per minute from a window count', () => {
  assert.equal(lambdaPerMin(0), 0);
  assert.equal(lambdaPerMin(5, 60_000), 5);
  assert.equal(lambdaPerMin(225, 5 * 60_000), 45);   // the measured λ≈45/min at a 5-min window
  assert.equal(lambdaPerMin(10, 0), 0);              // a zero window is not a measurement
});

test('inflight: dispatches in the boot window minus workers that already registered, never negative', () => {
  assert.equal(inflightFrom({ recentDispatches: 3, recentRegistrations: 1 }), 2);
  assert.equal(inflightFrom({ recentDispatches: 1, recentRegistrations: 2 }), 0);
  assert.equal(inflightFrom({}), 0);
});

test('desired workers: Ф8 boots one on a cold queue, Little law sizes a sustained λ, the ceiling holds', () => {
  // a cold pool with one call: one worker, not the whole reserve
  assert.equal(desiredWorkers({ queued: 0, demand: 1, live: 0 }), 1);
  // a non-empty queue always adds a worker (Ф8), even if one is already live
  assert.equal(desiredWorkers({ queued: 1, live: 1 }), 2);
  // λ=45/min, τ=10 s -> N=ceil(450/60)=8 (the reserve is headroom under the ceiling, not a floor)
  assert.equal(desiredWorkers({ queued: 1, lambdaPerMin: 45, serviceMs: SERVICE_MS_DEFAULT }), 8);
  // never above ceiling minus reserve: the account has 20 job slots, two stay for ordinary CI
  assert.equal(desiredWorkers({ queued: 100, lambdaPerMin: 10_000 }), POOL_CEILING - POOL_RESERVE);
  // an empty queue never scales up
  assert.equal(desiredWorkers({ queued: 0, live: 3 }), 3);
});

test('scale decision: names why it dispatches, and nothing boots while a worker is in flight', () => {
  const cold = scaleDecision({ queued: 0, demand: 1, live: 0 });
  assert.equal(cold.toDispatch, 1);
  assert.equal(cold.reason, 'queue_not_empty');
  const inflight = scaleDecision({ queued: 1, live: 0, inflight: 1 });
  assert.equal(inflight.toDispatch, 0);
  const atCeiling = scaleDecision({ queued: 50, live: POOL_CEILING - POOL_RESERVE });
  assert.equal(atCeiling.toDispatch, 0);
  assert.equal(atCeiling.reason, 'at_ceiling');
});

const RING = { repo: 'ring/one', token_ref: 'env:RING_TOKEN' };
function fakeGithub() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });   // 204 must carry a null body
  };
  return { calls, fetchImpl };
}
const postF = (path, body, d1, fetchImpl, extra = {}) =>
  handle(new Request(`https://l.test${path}`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1, extra), { fetchImpl });

test('scale: dispatches zen-pool into a ring repo, records it, and does not double-dispatch while it boots', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const gh = fakeGithub();
  const extra = { RING_TOKEN: 'gh-tok' };

  const res = await postF('/zen/pool/scale', { demand: 1 }, d1, gh.fetchImpl, extra);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.dispatched.length, 1);
  assert.equal(out.dispatched[0].repo, 'ring/one');
  assert.equal(out.ttl_ms, POOL_TTL_MS);
  assert.equal(gh.calls.length, 1);
  assert.match(gh.calls[0].url, /repos\/ring\/one\/dispatches$/);
  assert.equal(gh.calls[0].body.event_type, 'zen-pool');
  assert.equal(gh.calls[0].body.client_payload.idle_exit_ms, POOL_TTL_MS);

  // the worker is booting: a second call inside the boot window must dispatch nothing
  const again = await postF('/zen/pool/scale', { demand: 1 }, d1, gh.fetchImpl, extra);
  const out2 = await again.json();
  assert.equal(out2.dispatched.length, 0);
  assert.equal(out2.inflight, 1);
  assert.equal(gh.calls.length, 1);
});

test('scale: with no ring repo it says so instead of pretending to boot', async () => {
  const d1 = fakeD1();
  const gh = fakeGithub();
  const res = await postF('/zen/pool/scale', { demand: 1 }, d1, gh.fetchImpl);
  assert.equal(res.status, 503);
  const out = await res.json();
  assert.equal(out.reason, 'no_ring_repo');
  assert.equal(gh.calls.length, 0);
});

test('metrics: λ from the task table, the ceiling and the verdict, in one answer', async () => {
  const d1 = fakeD1({ repos: [RING] });
  for (let i = 0; i < 3; i++) d1._tasks.set(`t${i}`, { id: `t${i}`, state: 'queued', enqueued_at: NOW - 1000 });
  const res = await get('/zen/pool/metrics', d1);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.lambda_count, 3);
  assert.equal(m.lambda_per_min, 0.6);   // 3 arrivals over the 5-min window
  assert.equal(m.queued, 3);
  assert.equal(m.ceiling, POOL_CEILING);
  assert.equal(m.reserve, POOL_RESERVE);
  assert.equal(m.autoscale, true);
  assert.equal(m.toDispatch, 1);         // Ф8: the queue is not empty and nothing is live
});

test('rotation: a spent address hands its lease back, so the pool boots a fresh run on a new one', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const gh = fakeGithub();
  const extra = { RING_TOKEN: 'gh-tok' };

  const reg = await post('/zen/pool/register', { worker_id: 'ring/one:9:1', repo: 'ring/one' }, d1, extra);
  const lease = await reg.json();
  const pending = postF('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: '2+4?', wait_ms: 5000 }, d1, gh.fetchImpl, extra);
  await new Promise((r) => setTimeout(r, 60));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;
  assert.ok(task);

  // The provider answers 429 with a retry-after that lands on midnight UTC: the address is spent.
  const res = await post('/zen/pool/result', { task_id: task.id, ok: false, kind: 'daily', error: 'Rate limit exceeded' }, d1, extra);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rotate, true);
  assert.equal(body.bye, true);
  assert.match(body.rotate_reason, /address spent/);

  // The lease is gone immediately — not after the 90 s TTL — so the pool sees the hole at once.
  const health = await get('/zen/pool/health', d1, {});
  assert.equal((await health.json()).workers_live, 0);

  // And the next scale tick boots a replacement, which is the whole point: a new run = a new
  // egress address = a fresh ~1000-request daily quota.
  const scale = await postF('/zen/pool/scale', { demand: 1 }, d1, gh.fetchImpl, extra);
  const sb = await scale.json();
  assert.equal(sb.toDispatch, 1);
  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0].url, 'https://api.github.com/repos/ring/one/dispatches');

  // The caller whose task failed is told so, not left hanging.
  const failed = await pending;
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).kind, 'daily');
});

test('rotation: a transient failure does NOT give the lease back — the address is still good', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:3:1' }, d1);
  const lease = await reg.json();
  const pending = post('/zen/pool/invoke', { model: 'mimo-v2.6-flash-free', prompt: '2+4?', wait_ms: 5000 }, d1);
  await new Promise((r) => setTimeout(r, 60));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;

  // Three separate tasks: a result is accepted once per task, so each failure needs its own.
  for (const kind of ['timeout', 'error', 'context']) {
    const pend = post('/zen/pool/invoke', { model: 'mimo-v2.6-flash-free', prompt: '2+4?', wait_ms: 5000 }, d1);
    await new Promise((r) => setTimeout(r, 60));
    const pl = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
    const t = (await pl.json()).task;
    assert.ok(t);
    const res = await post('/zen/pool/result', { task_id: t.id, ok: false, kind, error: 'transient' }, d1);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).rotate, false);
    const failed = await pend;
    assert.equal(failed.status, 502);
  }
  const health = await get('/zen/pool/health', d1, {});
  assert.equal((await health.json()).workers_live, 1);
});

test('rotation: the local daily budget also rotates — a worker with no quota left must not idle', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:4:1' }, d1);
  const lease = await reg.json();
  const pending = post('/zen/pool/invoke', { model: 'mimo-v2.6-flash-free', prompt: '2+4?', wait_ms: 5000 }, d1);
  await new Promise((r) => setTimeout(r, 60));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;

  const res = await post('/zen/pool/result', { task_id: task.id, ok: false, kind: 'cooldown', stopped_by: 'local-budget', error: 'daily budget spent on this model' }, d1);
  assert.equal((await res.json()).rotate, true);
  const health = await get('/zen/pool/health', d1, {});
  assert.equal((await health.json()).workers_live, 0);
});

test('cold start: invoke on an empty pool boots a worker and the answer still lands in the same call', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const gh = fakeGithub();
  const extra = { RING_TOKEN: 'gh-tok' };
  const pending = postF('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: '2+4?', wait_ms: 5000 }, d1, gh.fetchImpl, extra);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(gh.calls.length, 1);   // the cold call itself triggered the boot

  // the booted worker registers and pulls the task the cold call enqueued
  const reg = await post('/zen/pool/register', { worker_id: 'ring/one:9:1', repo: 'ring/one' }, d1, extra);
  const lease = await reg.json();
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;
  assert.ok(task);
  await post('/zen/pool/result', { task_id: task.id, ok: true, text: 'six', provider_ms: 2100, served_ms: 2300 }, d1, extra);

  const res = await pending;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, 'six');
  assert.equal(body.cold_start.dispatched[0], 'ring/one');
});
