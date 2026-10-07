// HTTP route of the RING worker — dependency-free of the Workerd runtime so it runs in plain
// `node --test`, while src/index.js remains the Worker entry. Only the ring surface lives here:
// /zen/* (registry, budgets, leases) and the runs-pool control tail /pool/*. There is deliberately
// no /v1 chat surface and no ladder config — the ladder is a different product in a different
// repository, and carrying it here is what made the two get mixed up.

import * as zen from './zen-runner.js';
import * as pool from './zen-pool.js';

// Shared by the runs-pool trigger below. The ladder's own token gate does not exist here: every
// route above either has no auth (/health, /zen/pool/health) or guards itself
// (ZEN_RUNNER_TOKEN, ZEN_RING_ADMIN_TOKEN, POOL_TRIGGER_TOKEN).
function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function bearerToken(request) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  return m ? m[1].trim() : null;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function oaError(status, message, type, extra = {}, headers = {}) {
  return json(status, { error: { message, type, ...extra } }, headers);
}

// ── Pool endpoints (owner decision 2026-10-01): the control-plane tail for the runs pool.
// Only metadata + references travel through here: a task string ≤ 4000 chars and optional
// pointers. Gigabytes NEVER go through this API — big payloads move presigned-URL direct
// between the client and object storage, and `artifactRef` is just the reference: the worker
// never downloads it, only relays it in the dispatch.
const POOL_DISPATCH_URL = 'https://api.github.com/repos/vovalikessmoothy-png/ai-agent-runs-pool/dispatches';
const POOL_DISPATCH_TIMEOUT_MS = 10_000;
const POOL_BODY_MAX_BYTES = 8 * 1024;
const POOL_TASK_MAX_CHARS = 4000;
// location (epic ai-agent-run-api#1, Ф1): "" = наш пул; ru/eu/us зарезервированы под
// региональные пулы (вне скоупа) — принимаются, но помечаются reserved и не исполняются.
const POOL_LOCATIONS = ['', 'ru', 'eu', 'us'];
const POOL_RESERVED_LOCATIONS = new Set(['ru', 'eu', 'us']);

// POST /pool/trigger — own token (POOL_TRIGGER_TOKEN), independent of the ring tokens,
// timing-safe compare; env not set → 503 CONFIG. Body ≤ 8 KB → one GitHub
// repository_dispatch (10 s cap) → 202 {queued:true, location}. Logs metadata only (task
// length, location, statuses) — never the task text or any token.
async function poolTrigger(request, env, fetchImpl) {
  if (!env.POOL_TRIGGER_TOKEN || !env.GITHUB_AI_AGENT_RUNS_POOL) {
    return oaError(503, 'pool trigger not configured', 'CONFIG');
  }
  const presented = bearerToken(request);
  if (!presented || !timingSafeEqual(presented, String(env.POOL_TRIGGER_TOKEN).trim())) {
    return oaError(401, 'unauthorized', 'auth_error');
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > POOL_BODY_MAX_BYTES) {
    return oaError(413, `body too large (max ${POOL_BODY_MAX_BYTES} bytes)`, 'invalid_request_error');
  }
  let body;
  try { body = JSON.parse(raw); } catch { return oaError(400, 'bad json', 'invalid_request_error'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return oaError(400, 'json object required', 'invalid_request_error');
  const { task, repo, profile, artifactRef, location } = body;
  if (typeof task !== 'string' || !task.trim()) return oaError(400, 'task required', 'invalid_request_error');
  if (task.length > POOL_TASK_MAX_CHARS) return oaError(400, `task too long (max ${POOL_TASK_MAX_CHARS} chars)`, 'invalid_request_error');
  for (const [field, value] of Object.entries({ repo, profile, artifactRef })) {
    if (value !== undefined && typeof value !== 'string') return oaError(400, `${field} must be a string`, 'invalid_request_error');
  }
  // absent field == empty location (D4); anything else outside the enum → 400 naming the field (D3)
  if (location !== undefined && typeof location !== 'string') {
    return oaError(400, 'location must be a string (one of "", "ru", "eu", "us")', 'invalid_request_error');
  }
  const loc = location === undefined ? '' : location;
  if (!POOL_LOCATIONS.includes(loc)) {
    return oaError(400, `location: expected one of "", "ru", "eu", "us", got ${JSON.stringify(String(loc).slice(0, 50))}`, 'invalid_request_error');
  }
  const reserved = POOL_RESERVED_LOCATIONS.has(loc);
  const started = Date.now();
  const meta = { route: 'pool/trigger', task_len: task.length, location: loc };
  let res;
  try {
    res = await fetchImpl(POOL_DISPATCH_URL, {
      method: 'POST',
      headers: {
        authorization: `token ${env.GITHUB_AI_AGENT_RUNS_POOL}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        'user-agent': 'zen-rings',
      },
      // undefined optionals are dropped by JSON.stringify; artifactRef rides along untouched.
      // location is always present (normalized) so the receiver never has to guess D4.
      body: JSON.stringify({ event_type: 'agent-task', client_payload: { task, repo, profile, artifactRef, location: loc, ts: new Date().toISOString() } }),
      signal: AbortSignal.timeout(POOL_DISPATCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.log(JSON.stringify({ ...meta, ok: false, err: (e && e.name) || 'Error', ms: Date.now() - started }));
    return json(502, { error: 'dispatch_failed', gh_status: null });
  }
  console.log(JSON.stringify({ ...meta, ok: res.ok, gh_status: res.status, ms: Date.now() - started }));
  if (!res.ok) return json(502, { error: 'dispatch_failed', gh_status: res.status });
  return json(202, { queued: true, location: loc, ...(reserved ? { reserved: true } : {}) });
}

export async function handle(request, env, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    // Liveness only. The registry size, live caps and model verdicts live on /zen/health.
    return json(200, { ok: true, service: 'zen-ring', build: env.BUILD_SHA || null });
  }
  // Runs-pool control plane: its own token, plus a no-auth health. Unrelated to the ring —
  // it stays here because it predates this worker and still has its own consumer.
  if (request.method === 'GET' && url.pathname === '/pool/health') {
    return json(200, { service: 'pool', ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/pool/trigger') {
    return poolTrigger(request, env, fetchImpl);
  }
  // Zen Runner control plane: its own token (ZEN_RUNNER_TOKEN). Every route below either has
  // no auth or guards itself — there is no shared gate, because there is no ladder here.
  if (request.method === 'GET' && url.pathname === '/zen/health') return zen.zenHealth(request, env);
  if (request.method === 'GET' && url.pathname === '/zen/models') return zen.zenModels(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/run') return zen.zenRun(request, env, fetchImpl);
  if (request.method === 'POST' && url.pathname === '/zen/report') return zen.zenReport(request, env);
  if (request.method === 'GET' && url.pathname.startsWith('/zen/result/')) return zen.zenResult(request, env, url.pathname.slice('/zen/result/'.length));
  if (request.method === 'POST' && url.pathname === '/zen/repos') return zen.zenRepos(request, env);
  // Ring registry read-out: same table, different trust level. ZEN_RING_ADMIN_TOKEN, never given to
  // a ring member — /zen/ring/payload is the only route that hands out plaintext tokens.
  if (request.method === 'GET' && url.pathname === '/zen/ring/repos') return zen.zenRingRepos(request, env);
  if (request.method === 'GET' && url.pathname === '/zen/ring/payload') return zen.zenRingPayload(request, env);
  // The ring — a long-lived job as an API. Same token and placement as the routes above.
  if (request.method === 'GET' && url.pathname === '/zen/pool/health') return pool.zenPoolHealth(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/register') return pool.zenPoolRegister(request, env);
  if (request.method === 'GET' && url.pathname === '/zen/pool/pull') return pool.zenPoolPull(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/result') return pool.zenPoolResult(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/stop') return pool.zenPoolStop(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/invoke') return pool.zenPoolInvoke(request, env, fetchImpl);
  if (request.method === 'GET' && url.pathname === '/zen/pool/metrics') return pool.zenPoolMetrics(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/scale') return pool.zenPoolScale(request, env, fetchImpl);
  const mResult = /^\/zen\/pool\/result\/([A-Za-z0-9._-]{1,80})$/.exec(url.pathname);
  if (request.method === 'GET' && mResult) return pool.zenPoolResultById(request, env, mResult[1]);


  return oaError(404, 'not found', 'invalid_request_error');
}