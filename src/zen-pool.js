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

import { applyReport, budgetVerdict, LIMITS, readModel, writeModel, bumpCount, readCounts, authorized, resolveToken, pickNextRepo, sharedDayCap } from './zen-runner.js';

export const DEFAULT_WAIT_MS = 30_000;   // the owner's default watchdog
export const MIN_WAIT_MS = 1_000;
export const MAX_WAIT_MS = 90_000;      // under the edge's idle timeout; longer = poll the result
export const DEFAULT_PULL_HOLD_MS = 20_000;  // how long one pull stays open before it re-polls
export const MIN_PULL_HOLD_MS = 5_000;
export const MAX_PULL_HOLD_MS = 25_000;
export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;  // a job with no work for this long exits itself
export const LEASE_TTL_MS = 90_000;     // a job that stops pulling is dead after this
export const ORPHAN_TASK_MS = 120_000;  // a claimed task with no answer for this long is requeued

// ---- pool ceiling + autoscaling (owner's numbers, see zen-runner/tz-pul-zhizni.md) -----------
// The account allows 20 simultaneous Actions jobs, so the pool can never exceed that — and two
// of the 20 stay free so an ordinary push/PR CI run is never starved by our own workers.
export const POOL_CEILING = 20;
export const POOL_RESERVE = 2;
// The TTL is the whole point of the pool: one boot (~10-13 s measured) amortised over hours.
// 167 min is the computed TTL for N≈16 workers at λ≈45/min (T = D·N/λ), safely inside the 6 h
// job ceiling. A worker still exits earlier on idle_exit_ms; this is the dispatched default.
export const POOL_TTL_MS = 167 * 60_000;
// λ is measured from the task table over a rolling window: every enqueue is one arrival.
export const LAMBDA_WINDOW_MS = 5 * 60_000;
// A dispatched worker needs ~10-13 s to boot and register; until it does, it must count as
// "in flight" or every look at the queue would dispatch a second worker for the same task.
export const BOOT_MS = 25_000;
// How long one task occupies a worker (measured 2.7-9.5 s end to end; 10 s is the planning
// number). Little's law: N = λ·τ — this is what the scale decision is built on.
export const SERVICE_MS_DEFAULT = 10_000;
const DISPATCH_TIMEOUT_MS = 10_000;
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

// Should this worker give up its lease after a failed call?
//
// The measured reality (2026-10-04, three live runs): the daily quota is ~1000 requests per
// (egress IP, model) and a GitHub Actions run gets a NEW egress IP every time it boots — five
// consecutive runs on this account came up on 13.71.231.39, 128.203.190.81, 172.184.213.225,
// 172.184.211.241, 135.232.201.244. So an address that answered `daily` is not a dead model and
// not a dead provider: it is a spent address, and the cure is a new job, not a retry.
//
// That makes this the one rotation point of the whole pool. A worker that keeps its lease after
// `daily` goes on claiming tasks and failing every one of them — each failure burns a queued task
// and the caller's watchdog — while the address stays dark until 00:00 UTC. Handing the lease back
// is what lets the autoscaler boot a fresh run, which lands on a fresh address with a full quota.
//
// `provider` (a bare 429 with no retry-after) is the same wall seen from the other side: the
// per-minute burst limit, measured at ~90-95/min per (IP, model). Our own governor holds 50/min, so
// hitting it means the address is being shared with something else and is equally spent.
// `rate` is the same shape without the provider marker. `timeout` and `error` are NOT rotation:
// those are transient and the address is still good, so the worker stays and serves the next task.
export function shouldRotateOnResult(kind) {
  return kind === 'daily' || kind === 'provider' || kind === 'rate';
}

// Same question for the LOCAL budget: once a worker has spent its own daily allowance it is out of
// addresses' worth of quota too, so it rotates instead of sitting on a lease it can never use.
export function shouldRotateOnLocalStop(stoppedBy) {
  return stoppedBy === 'local-budget';
}

// A lease is usable only while the job is live AND has not gone silent: a job that died without
// saying goodbye simply stops renewing, and this is what drops it out of the pool.
export function leaseUsable(row, now) {
  return !!row && row.state === 'live' && !leaseExpired(row, now);
}

// ---- autoscaling logic (pure, unit-tested) ---------------------------------------------------

// λ, arrivals per minute, from a raw count over a window. Kept as its own function because the
// window is a knob: the caller's own traffic is bursty and a 5-min mean is what the pool sizes to.
export function lambdaPerMin(count, windowMs = LAMBDA_WINDOW_MS) {
  const n = Number(count) || 0;
  if (!(windowMs > 0)) return 0;
  return (n * 60_000) / windowMs;
}

// Workers already being born but not yet registered: dispatches in the boot window minus workers
// that registered inside it. Floored at 0 so a burst of registrations never goes negative.
export function inflightFrom({ recentDispatches = 0, recentRegistrations = 0 } = {}) {
  return Math.max(0, (Number(recentDispatches) || 0) - (Number(recentRegistrations) || 0));
}

// How many workers SHOULD be live. Two rules, in order:
//   1. Ф8 — a non-empty queue scales up immediately: at least one more worker than there are
//      (this is what makes a cold pool answer a real call instead of returning 503);
//   2. Little's law — N = λ·τ, so a sustained λ is served without queueing.
// The ceiling minus the reserve is a hard cap: the account has 20 job slots and two of them stay
// free for ordinary CI. The reserve is headroom, not a floor — a single cold call boots one worker,
// not three. An empty queue never scales up: idle workers exit on their own TTL.
export function desiredWorkers({
  lambdaPerMin: lambda = 0, serviceMs = SERVICE_MS_DEFAULT, queued = 0, demand = 0,
  live = 0, inflight = 0, ceiling = POOL_CEILING, reserve = POOL_RESERVE,
} = {}) {
  const cap = Math.max(0, Number(ceiling) - Number(reserve));
  const pending = Math.max(Number(queued) || 0, Number(demand) || 0);
  if (pending <= 0) return Math.min(Number(live) || 0, cap);
  const byLaw = Math.ceil(((Number(lambda) || 0) * (Number(serviceMs) || 0)) / 60_000);
  const want = Math.max(1, (Number(live) || 0) + 1, byLaw);
  return Math.min(want, cap);
}

// The whole decision in one place: how many to boot right now and why. `reason` is what the
// endpoint reports, so an operator never has to guess why nothing was dispatched.
export function scaleDecision({
  lambdaPerMin: lambda = 0, serviceMs = SERVICE_MS_DEFAULT, queued = 0, demand = 0,
  live = 0, inflight = 0, ceiling = POOL_CEILING, reserve = POOL_RESERVE,
} = {}) {
  const desired = desiredWorkers({ lambdaPerMin: lambda, serviceMs, queued, demand, live, inflight, ceiling, reserve });
  const toDispatch = Math.max(0, desired - (Number(live) || 0) - (Number(inflight) || 0));
  let reason = 'at_target';
  if (toDispatch > 0) reason = Math.max(Number(queued) || 0, Number(demand) || 0) > 0 ? 'queue_not_empty' : 'lambda';
  else if (desired >= Math.max(0, Number(ceiling) - Number(reserve))) reason = 'at_ceiling';
  return { desired, toDispatch, reason, lambdaPerMin: lambda, queued, live, inflight };
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

// ---------------------------------------------------------------- pool metrics + dispatch

const poolCeiling = (env) => Math.max(1, Number(env.ZEN_POOL_CEILING) || POOL_CEILING);
const poolReserve = (env) => Math.max(0, Number(env.ZEN_POOL_RESERVE) || POOL_RESERVE);
const poolTtl = (env) => Math.max(60_000, Number(env.ZEN_POOL_TTL_MS) || POOL_TTL_MS);

async function readQueued(env) {
  return (await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_tasks WHERE state = ?1').bind('queued').first())?.n ?? 0;
}

// λ: every row in zen_pool_tasks was one arrival, so a window count is the whole measurement —
// no separate metrics table to drift out of sync with reality.
async function readLambda(env, now, windowMs = LAMBDA_WINDOW_MS) {
  const row = await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_tasks WHERE enqueued_at > ?1')
    .bind(now - windowMs).first();
  return { count: row?.n ?? 0, windowMs, perMin: lambdaPerMin(row?.n ?? 0, windowMs) };
}

async function readInflight(env, now) {
  const since = now - BOOT_MS;
  const dispatched = (await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_dispatches WHERE requested_at > ?1').bind(since).first())?.n ?? 0;
  const registered = (await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_workers WHERE registered_at > ?1').bind(since).first())?.n ?? 0;
  return inflightFrom({ recentDispatches: dispatched, recentRegistrations: registered });
}

export async function recentDispatches(env, limit = 10) {
  return (await db(env).prepare(
    'SELECT id, repo, reason, requested_at, worker_id, state FROM zen_pool_dispatches ORDER BY requested_at DESC LIMIT ?1'
  ).bind(limit).all()).results || [];
}

async function recordDispatch(env, { id, repo, reason, now }) {
  await db(env).prepare(
    'INSERT INTO zen_pool_dispatches (id, repo, reason, requested_at, state) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(id, repo, reason, now, 'dispatched').run();
}

// One dispatch = one long-lived pool worker in a ring repository. The repo token is the same one
// the cold-dispatch path uses; a repo without a usable token is simply skipped.
async function dispatchPoolWorker(env, repo, row, token, { idleExitMs, runId, now, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: { authorization: `token ${token}`, 'content-type': 'application/json',
      accept: 'application/vnd.github+json', 'user-agent': 'zen-rings' },
    body: JSON.stringify({ event_type: 'zen-pool', client_payload: {
      run_id: runId, idle_exit_ms: idleExitMs, max_tasks: 0, out: 'zen-pool-last.json',
      requested_at: new Date(now).toISOString(), location: row?.location || '',
    } }),
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  return res.status;
}

// The autoscaler. Called from /zen/pool/scale (a scheduled workflow) and from /zen/pool/invoke
// when the pool is cold — the second caller is what makes "scale up the moment a call arrives"
// true rather than "within the next cron tick". Returns what it decided and what it dispatched.
export async function scalePool(env, { now, demand = 0, fetchImpl = fetch } = {}) {
  const t = now ?? nowMs(env);
  const ceiling = poolCeiling(env), reserve = poolReserve(env), ttl = poolTtl(env);
  if (String(env.ZEN_POOL_AUTOSCALE || '').toLowerCase() === 'off') {
    return { ok: false, reason: 'autoscale_off', dispatched: [], ceiling, reserve, ttl_ms: ttl };
  }
  const live = (await readLiveWorkers(env, t)).length;
  const queued = await readQueued(env);
  const inflight = await readInflight(env, t);
  const lambda = await readLambda(env, t);
  const decision = scaleDecision({
    lambdaPerMin: lambda.perMin, queued, demand, live, inflight, ceiling, reserve,
    serviceMs: Number(env.ZEN_POOL_SERVICE_MS) || SERVICE_MS_DEFAULT,
  });
  const out = { ok: true, ...decision, lambda_count: lambda.count, window_ms: lambda.windowMs,
    ceiling, reserve, ttl_ms: ttl, dispatched: [], errors: [] };
  if (decision.toDispatch <= 0) return out;

  const repos = (await db(env).prepare('SELECT * FROM zen_repos WHERE enabled = 1 ORDER BY added_at, repo').all()).results || [];
  if (!repos.length) {
    out.ok = false; out.reason = 'no_ring_repo';
    out.hint = 'POST /zen/repos {repo, token|token_ref} — the pool can only boot a worker in a registered repo';
    return out;
  }
  const cursorRow = await db(env).prepare("SELECT v FROM zen_meta WHERE k = 'pool_cursor'").first();
  let cursor = Number(cursorRow?.v) || 0;
  const skip = new Set();
  for (let i = 0; i < decision.toDispatch; i++) {
    const pick = pickNextRepo(repos, cursor, skip);
    if (!pick) { out.errors.push({ error: 'no usable ring repository' }); break; }
    cursor = pick.cursor;
    const token = await resolveToken(pick.row, env);
    if (!token) { skip.add(pick.repo); out.errors.push({ repo: pick.repo, error: 'no usable token' }); i--; continue; }
    const id = `${t.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    let status;
    try {
      status = await dispatchPoolWorker(env, pick.repo, pick.row, token, { idleExitMs: ttl, runId: id, now: t, fetchImpl });
    } catch (e) {
      out.errors.push({ repo: pick.repo, error: `dispatch_failed:${e?.name || 'Error'}` });
      continue;
    }
    if (status < 200 || status >= 300) { out.errors.push({ repo: pick.repo, gh_status: status }); continue; }
    await recordDispatch(env, { id, repo: pick.repo, reason: decision.reason, now: t });
    out.dispatched.push({ id, repo: pick.repo, idle_exit_ms: ttl });
  }
  await db(env).prepare('INSERT INTO zen_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind('pool_cursor', String(cursor)).run();
  if (!out.dispatched.length && out.ok) { out.ok = false; out.reason = out.reason === 'at_target' ? 'at_target' : 'dispatch_failed'; }
  return out;
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

  // The rotation point. A quota refusal means this run's egress address is spent, and a new run
  // gets a new one — so the worker is told to hand its lease back instead of claiming the next task
  // and failing that too. `bye: true` here is what the worker's pull loop acts on; the autoscaler
  // then sees one fewer live worker and boots a replacement on a fresh address.
  const rotate = shouldRotateOnResult(body.ok ? null : body.kind) || shouldRotateOnLocalStop(body.stopped_by);
  if (rotate) {
    await db(env).prepare(
      "UPDATE zen_pool_workers SET state = ?1, stop_reason = ?2, exited_at = ?3 WHERE id = ?4 AND state = 'live'"
    ).bind('gone', `quota:${String(body.kind || 'unknown').slice(0, 40)}`, now, task.lease_id).run();
  }
  return j(200, {
    accepted: true, task_id: taskId, state: state.status, next_check_in: Math.max(0, state.next_check_at - now),
    rotate, bye: rotate,
    rotate_reason: rotate ? `address spent (${body.kind || 'unknown'}) — start a new run for a fresh one` : null,
  });
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
export async function zenPoolInvoke(request, env, fetchImpl = fetch) {
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

  // Deliberately NO quarantine check here. The quarantine table answers "should we go and PROBE this
  // model on a schedule" — it exists so the self-test stops poking a dead provider 100 times. It
  // must not answer "a caller named this model explicitly and wants an answer": that is the whole
  // point of the pool, and the budget below is the real protection. The result is still recorded
  // (applyReport below), so an explicit call is also the cheapest possible re-check.
  const workers = await readLiveWorkers(env, now);
  // Cold pool: instead of a bare 503, boot a worker now and let the caller's own watchdog cover the
  // ~10-13 s boot — the task is enqueued below and the worker claims it on its first pull. Only
  // when there is nothing to boot with (autoscale off, no ring repo, ceiling reached) is the 503
  // still the honest answer.
  let coldStart = null;
  if (!workers.length) {
    coldStart = await scalePool(env, { now, demand: 1, fetchImpl });
    if (!coldStart.dispatched.length) {
      return j(503, { error: 'no warm runner', scaled: coldStart.reason, ceiling: coldStart.ceiling,
        reserve: coldStart.reserve, hint: coldStart.hint || 'dispatch zen-pool.yml in a ring repository, or use POST /zen/run for a cold dispatch' });
    }
  }
  const repoScope = workers[0]?.repo || coldStart?.dispatched?.[0]?.repo || '*';
  // Same two levels as /zen/run: the day cap is per (repo, model), and '*' is only the runaway
  // brake — its day cap is the sum of the independent per-model allowances, so one provider's
  // spending never refuses another provider.
  const perRepo = budgetVerdict(await readCounts(env, repoScope, model), now,
    { perMin: Number(env.ZEN_PER_MIN) || LIMITS.perMin, perDay: Number(env.ZEN_PER_DAY) || LIMITS.perDay });
  const perAll = budgetVerdict(await readCounts(env, '*', '*'), now,
    { perMin: Number(env.ZEN_PER_MIN) || LIMITS.perMin, perDay: await sharedDayCap(env, now, Number(env.ZEN_PER_DAY) || LIMITS.perDay) });
  for (const v of [perRepo, perAll]) {
    if (!v.ok) return j(429, { error: `budget exhausted (${v.reason})`, reason: v.reason, retry_after: v.retry_after });
  }

  const id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  await db(env).prepare(
    'INSERT INTO zen_pool_tasks (id, model, prompt, max_tokens, wait_ms, state, enqueued_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  ).bind(id, model, prompt.slice(0, 4000), maxTokens, waitMs, 'queued', now).run();
  await bumpCount(env, repoScope, model, now);
  await bumpCount(env, '*', '*', now);

  const cold = coldStart ? { scaled: coldStart.reason, dispatched: coldStart.dispatched.map((d) => d.repo), boot_ms: BOOT_MS } : null;
  const deadline = Date.now() + waitMs;
  let step = 0;
  for (;;) {
    const row = await readTask(env, id);
    if (row.state === 'done' || row.state === 'failed') {
      return j(row.state === 'done' ? 200 : 502, {
        task_id: id, model, ok: !!row.ok, text: row.text || null, kind: row.kind,
        error: row.error, provider_ms: row.provider_ms, served_ms: row.served_ms,
        worker_id: row.worker_id, wait_ms: waitMs, ...(cold ? { cold_start: cold } : {}),
      });
    }
    if (Date.now() >= deadline) {
      await db(env).prepare('UPDATE zen_pool_tasks SET wait_returned_at = ?1 WHERE id = ?2').bind(nowMs(env), id).run();
      return j(504, { error: 'watchdog fired before the answer arrived', task_id: id, wait_ms: waitMs,
        ...(cold ? { cold_start: cold } : {}),
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

// GET /zen/pool/metrics — the autoscaler's inputs and its verdict, in one place. This is what the
// scheduled scale workflow reads and what an operator reads when asking "why is the pool this big".
export async function zenPoolMetrics(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const now = nowMs(env);
  const ceiling = poolCeiling(env), reserve = poolReserve(env), ttl = poolTtl(env);
  const live = (await readLiveWorkers(env, now)).length;
  const queued = await readQueued(env);
  const inflight = await readInflight(env, now);
  const lambda = await readLambda(env, now);
  const decision = scaleDecision({
    lambdaPerMin: lambda.perMin, queued, live, inflight, ceiling, reserve,
    serviceMs: Number(env.ZEN_POOL_SERVICE_MS) || SERVICE_MS_DEFAULT,
  });
  return j(200, {
    now, service: 'zen-pool', lambda_per_min: Number(lambda.perMin.toFixed(3)), lambda_count: lambda.count,
    window_ms: lambda.windowMs, queued, workers_live: live, inflight, ceiling, reserve, ttl_ms: ttl,
    autoscale: String(env.ZEN_POOL_AUTOSCALE || 'on').toLowerCase() !== 'off',
    ...decision, dispatches: await recentDispatches(env, 10),
  });
}

// POST /zen/pool/scale {demand?} — run the autoscaler now. The scheduled workflow calls this; so
// does /zen/pool/invoke on a cold pool. Idempotent in effect: a worker already booting counts as
// in-flight, so a second call inside the boot window dispatches nothing.
export async function zenPoolScale(request, env, fetchImpl = fetch) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body = {};
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const demand = Math.min(Math.max(Number(body?.demand) || 0, 0), POOL_CEILING);
  const out = await scalePool(env, { now: nowMs(env), demand, fetchImpl });
  return j(out.ok ? 200 : 503, out);
}

// GET /zen/pool/health — how many jobs are live right now (no auth, like /zen/health).
export async function zenPoolHealth(request, env) {
  const now = nowMs(env);
  const out = { service: 'zen-pool', ok: !!env.ZEN_DB, workers_live: 0, workers: [], queued: 0,
    ceiling: poolCeiling(env), reserve: poolReserve(env), ttl_ms: poolTtl(env), default_wait_ms: DEFAULT_WAIT_MS };
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
