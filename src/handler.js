// HTTP route of the ladder worker — dependency-free of the Workerd runtime so it runs in plain
// `node --test` (the sandbox imports it), while src/index.js remains the Worker entry: it wraps this
// handler and exports the LadderState Durable Object for the platform binding.

import { run, readPool, fetchGoUsage, DEFAULT_LADDER, sanitizeAppSlug, sanitizeAppTitle } from './ladder.js';
import { makeTrace, logCall } from './trace.js';
import * as zen from './zen-runner.js';
import * as pool from './zen-pool.js';
import config from '../config/ladders.json' with { type: 'json' };
import prices from '../config/prices.json' with { type: 'json' };

// GET /v1/analytics: both bind ?1 = since (ms). Aggregates per requested ladder name;
// the depth histogram is attempts-per-call from the attempts JSON (json_valid guards
// legacy rows). Keep the bind: an interpolated timestamp is an injection (query-trace
// guard tests the same rule for the python read path).
const ANALYTICS_AGG_SQL =
  'SELECT ladder, COUNT(*) AS calls, SUM(1 - ok) AS failed, '
  + 'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_out, 0)) AS tout, '
  + 'SUM(CASE WHEN tokens_in IS NULL THEN 1 ELSE 0 END) AS no_usage '
  + 'FROM ladder_calls WHERE ts >= ?1 GROUP BY ladder';
// Per ladder × served model: calls + tokens (in / cached / out) so the caller can price each
// rung. Category is derived in JS (categoryOf) — the model already determines it.
const ANALYTICS_RUNGS_SQL =
  'SELECT ladder, model, COUNT(*) AS calls, '
  + 'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_cached, 0)) AS tcached, '
  + 'SUM(COALESCE(tokens_out, 0)) AS tout '
  + 'FROM ladder_calls WHERE ts >= ?1 AND ok = 1 GROUP BY ladder, model ORDER BY ladder, calls DESC';
// Hourly cut (#93): the same ladder × model breakdown bucketed by UTC hour, so every cost
// cut the owner asked for is one row per hour, not a per-call dump.
const ANALYTICS_HOURLY_SQL =
  "SELECT strftime('%Y-%m-%dT%H:00Z', ts / 1000, 'unixepoch') AS hour, ladder, model, "
  + 'COUNT(*) AS calls, SUM(ok) AS ok_n, '
  + 'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_cached, 0)) AS tcached, '
  + 'SUM(COALESCE(tokens_out, 0)) AS tout '
  + 'FROM ladder_calls WHERE ts >= ?1 GROUP BY hour, ladder, model ORDER BY hour DESC, calls DESC';
const ANALYTICS_DEPTH_SQL =
  'SELECT ladder, json_array_length(attempts) AS depth, COUNT(*) AS calls '
  + 'FROM ladder_calls WHERE ts >= ?1 AND attempts IS NOT NULL AND json_valid(attempts) '
  + 'GROUP BY ladder, depth';
// Raw error counts (top 100 by frequency, same as scripts/analytics.py). Grouping is on
// the RAW string — digit variants ('can only afford 499' / '776') are merged by
// normalizeError() below, mirroring analytics.py normalize_error.
const ANALYTICS_ERRORS_SQL =
  "SELECT json_extract(j.value, '$.error') AS err, COUNT(*) AS n "
  + 'FROM ladder_calls, json_each(ladder_calls.attempts) j '
  + "WHERE ts >= ?1 AND json_extract(j.value, '$.outcome') <> 'ok' "
  + "AND json_extract(j.value, '$.error') IS NOT NULL "
  + 'AND json_valid(ladder_calls.attempts) '
  + 'GROUP BY err ORDER BY n DESC LIMIT 100';

// Port of analytics.py normalize_error: keep the 'HTTP <status>:' head, mask digits in
// the payload so one failure with varying counts stays one bucket; cap at 160 chars.
// Truncation gets an ellipsis — without it the digest shows a raw mid-JSON cut
// ('…-flash-fin","c — 34') that reads as corruption.
export function normalizeError(err) {
  if (!err) return '(no message)';
  const clip = (s) => s.length > 160 ? s.slice(0, 159).trimEnd() + '…' : s;
  const s = String(err);
  const i = s.indexOf(': ');
  if (i !== -1 && /^HTTP \d+$/.test(s.slice(0, i).trim())) {
    const body = s.slice(i + 2).replace(/\d+/g, '#');
    return clip((s.slice(0, i + 2) + body).replace(/\s+/g, ' ').trim());
  }
  return clip(s.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim());
}

// Rung category — which free/paid tier a served model belongs to (#80). Derived in JS now
// that the rung query returns the model itself.
export function categoryOf(model) {
  if (!model) return 'other';
  if (model.startsWith('opencode-go/')) return model.endsWith('-free') ? 'go_free' : 'go_sub';
  if (model.startsWith('opencode-zen/')) return 'zen';
  if (model.startsWith('openrouter/')) return model.endsWith(':free') ? 'or_free' : 'or_paid';
  return 'other';
}

// Estimated $ for one ladder×model row: (in - cached)×in + out×out + cached×cachedRead, all
// per 1M tokens (config/prices.json). null = unknown price and not an obvious $0 rung.
export function costUsd(model, tin, tcached, tout) {
  if (!model) return null;
  const p = prices[model];
  if (!p) return (model.startsWith('opencode-zen/') || model.endsWith('-free') || model.endsWith(':free')) ? 0 : null;
  const fresh = Math.max(0, (tin || 0) - (tcached || 0));
  return (fresh * p[0] + (tout || 0) * p[1] + (tcached || 0) * p[2]) / 1e6;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function oaError(status, message, type, extra = {}, headers = {}) {
  return json(status, { error: { message, type, ...extra } }, headers);
}

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

function authorized(request, env) {
  if (!env.LADDER_TOKEN) return false;
  const token = bearerToken(request);
  return !!token && timingSafeEqual(token, env.LADDER_TOKEN);
}

// Pin kill-switch: LADDER_PIN_ENABLED=false/0/off disables sticky rungs entirely (no pin
// read/write, byte-for-byte today's behaviour). Default is enabled.
function pinEnabled(env) {
  return !/^(false|0|off)$/i.test(String(env.LADDER_PIN_ENABLED ?? ''));
}

async function sha256hex(s) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Extract a stable conversation id from the request (x-session-affinity → x-session-id →
// body.ladder_conversation), cap it at 256 chars, SHA-256 hash it. Returns null for
// unkeyed callers (service-llm, pr-autofix, bench) so the hot path is untouched.
export async function conversationKey(request, body, env) {
  if (!pinEnabled(env)) return null;
  const raw = String(
    request.headers.get('x-session-affinity') ||
    request.headers.get('x-session-id') ||
    (body && body.ladder_conversation) ||
    ''
  ).slice(0, 256).trim();
  return raw ? sha256hex(raw) : null;
}

export function makeStore(env) {
  const stub = env.LADDER_STATE.get(env.LADDER_STATE.idFromName('global'));
  const poolSize = readPool(env).length;
  return {
    snapshot: (poolSizeArg, pinKey) => stub.snapshot(poolSizeArg ?? poolSize, pinKey),
    recordFailure: (model, f, extra) => stub.recordFailure(model, f, extra),
    recordSuccess: (model, extra) => stub.recordSuccess(model, extra),
    rotateKey: (size, ttlMs, failedIndex) => stub.rotateKey(size, ttlMs, failedIndex),
    resetKeys: () => stub.resetKeys(),
    park: (models, untilMs) => stub.park(models, untilMs),
    pinStats: () => stub.pinStats(),
  };
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

// POST /pool/trigger — own token (POOL_TRIGGER_TOKEN, independent from LADDER_TOKEN),
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
        'user-agent': 'trained-assist-llm-ladder',
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

export async function handle(request, env, { store, fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(200, { ok: true, ladders: Object.keys(config.ladders), build: env.BUILD_SHA || null });
  }
  // Pool control-plane: its own token and no-auth health — both sit BEFORE the LADDER_TOKEN
  // gate below, so the ladder routes are untouched.
  if (request.method === 'GET' && url.pathname === '/pool/health') {
    return json(200, { service: 'pool', ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/pool/trigger') {
    return poolTrigger(request, env, fetchImpl);
  }
  // Zen Runner control plane: its own token (ZEN_RUNNER_TOKEN), before the LADDER_TOKEN gate —
  // same placement as the pool routes, so nothing in the ladder call path changes.
  if (request.method === 'GET' && url.pathname === '/zen/health') return zen.zenHealth(request, env);
  if (request.method === 'GET' && url.pathname === '/zen/models') return zen.zenModels(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/run') return zen.zenRun(request, env, fetchImpl);
  if (request.method === 'POST' && url.pathname === '/zen/report') return zen.zenReport(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/repos') return zen.zenRepos(request, env);
  // Zen Pool — a long-lived job as an API. Same token, same placement, before the ladder gate.
  if (request.method === 'GET' && url.pathname === '/zen/pool/health') return pool.zenPoolHealth(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/register') return pool.zenPoolRegister(request, env);
  if (request.method === 'GET' && url.pathname === '/zen/pool/pull') return pool.zenPoolPull(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/result') return pool.zenPoolResult(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/stop') return pool.zenPoolStop(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/invoke') return pool.zenPoolInvoke(request, env);
  const mResult = /^\/zen\/pool\/result\/([A-Za-z0-9._-]{1,80})$/.exec(url.pathname);
  if (request.method === 'GET' && mResult) return pool.zenPoolResultById(request, env, mResult[1]);
  if (!authorized(request, env)) return oaError(401, 'unauthorized', 'auth_error');

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    const data = [];
    for (const [name, roles] of Object.entries(config.ladders)) {
      data.push({ id: name, object: 'model', owned_by: 'trained-assist-llm-ladder', rungs: roles.build || [] });
      for (const role of Object.keys(roles)) if (role !== 'build') data.push({ id: `${name}:${role}`, object: 'model', owned_by: 'trained-assist-llm-ladder', rungs: roles[role] });
    }
    return json(200, { object: 'list', data });
  }

  // GET /v1/state
  if (request.method === 'GET' && url.pathname === '/v1/state') {
    const s = await (store || makeStore(env)).snapshot();
    s.pins = await (store || makeStore(env)).pinStats();
    return json(200, s);
  }

  // GET /v1/go-usage — remaining Go allowance per pool key (unified rolling/weekly/monthly
  // percent, issue #91). The raw key never appears in the response or the logs.
  if (request.method === 'GET' && url.pathname === '/v1/go-usage') {
    return json(200, { keys: await fetchGoUsage(env, { fetchImpl }) });
  }

  // GET /v1/calls — the per-CALL trace log, the read side /v1/analytics has no counterpart for.
  //
  // /v1/analytics answers "how did the ladder do"; this answers "what happened to THIS request":
  // which rungs were walked, in what order, what each one said, how long the whole thing took.
  // Until now the only way to get that was scripts/query-trace.py from a laptop with a Cloudflare
  // token — so a dead ladder call was unreadable for anyone but the operator holding that token.
  //
  // Every filter is bound (?1..?5), never interpolated: a trace id is caller-supplied. Requires at
  // least one filter — an unfiltered read of the whole log is what the analytics endpoint is for,
  // and it would page through rows nobody asked for. `attempts` comes back as parsed JSON so the
  // caller does not have to re-implement the parser.
  if (request.method === 'GET' && url.pathname === '/v1/calls') {
    const db = env.LADDER_TRACE_DB;
    if (!db) return oaError(503, 'trace database not configured', 'unavailable');
    const q = url.searchParams;
    const since = Math.min(Number(q.get('since_ms')) || Date.now() - 24 * 3600_000, Date.now());
    const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 200);
    const trace = q.get('trace'), user = q.get('user'), chat = q.get('chat'), session = q.get('session');
    if (!trace && !user && !chat && !session) {
      return oaError(400, 'one of trace, user, chat, session is required', 'invalid_request_error');
    }
    const CALLS_SQL =
      'SELECT ts, trace_id, run_id, user_id, chat_id, session_id, ladder, ok, model, ms, '
      + 'tokens_in, tokens_out, '
      // json_valid in SQL, not in JS: one legacy row with a non-JSON blob must not be able to
      // throw the whole read away (same guard the two analytics queries use).
      + "CASE WHEN attempts IS NOT NULL AND json_valid(attempts) THEN attempts ELSE NULL END AS attempts "
      + 'FROM ladder_calls WHERE ts >= ?1 '
      + 'AND (?2 IS NULL OR trace_id = ?2) AND (?3 IS NULL OR user_id = ?3) '
      + 'AND (?4 IS NULL OR chat_id = ?4) AND (?5 IS NULL OR session_id = ?5) '
      + 'ORDER BY ts DESC LIMIT ?6';
    try {
      const { results = [] } = await db.prepare(CALLS_SQL)
        .bind(since, trace, user, chat, session, limit).all();
      const calls = results.map((r) => ({ ...r, ok: !!r.ok, attempts: r.attempts ? JSON.parse(r.attempts) : null }));
      return json(200, { calls, count: calls.length, filters: { trace, user, chat, session }, since_ms: since });
    } catch (e) {
      return oaError(500, `calls query failed: ${e.message}`, 'server_error');
    }
  }

  // Aggregates over the D1 trace for the hourly Telegram digest (vm-telegram-monitor):
  // per-ladder calls / failures / tokens + the attempts-depth histogram the reporter turns
  // into a retry funnel. Read-only; window is whole hours 1..168 (default 24).
  if (request.method === 'GET' && url.pathname === '/v1/analytics') {
    const db = env.LADDER_TRACE_DB;
    if (!db) return oaError(503, 'trace database not configured', 'unavailable');
    const hours = Math.min(168, Math.max(1, Math.floor(Number(url.searchParams.get('hours')) || 24)));
    const since = Date.now() - hours * 3_600_000;
    try {
      const aggRows = (await db.prepare(ANALYTICS_AGG_SQL).bind(since).all()).results || [];
      const rungRows = (await db.prepare(ANALYTICS_RUNGS_SQL).bind(since).all()).results || [];
      const hourlyRows = (await db.prepare(ANALYTICS_HOURLY_SQL).bind(since).all()).results || [];
      const depthRows = (await db.prepare(ANALYTICS_DEPTH_SQL).bind(since).all()).results || [];
      const errRows = (await db.prepare(ANALYTICS_ERRORS_SQL).bind(since).all()).results || [];
      const num = (v) => Number(v) || 0;
      // Canonical ladder names only (no aliases since 2026-10-03). The default role
      // 'X:build' collapses to 'X'; non-default roles (:review, :explore) stay separate.
      const canonName = (raw) => {
        const [base, role] = String(raw || '').split(':');
        return !role || role === 'build' ? base : `${base}:${role}`;
      };
      const ladders = new Map();
      const entry = (raw) => {
        const ladder = canonName(raw);
        let e = ladders.get(ladder);
        if (!e) { e = { ladder, calls: 0, failed: 0, tokens_in: 0, tokens_out: 0, no_usage: 0, depth: [] }; ladders.set(ladder, e); }
        return e;
      };
      for (const r of aggRows) {
        const e = entry(r.ladder);
        e.calls += num(r.calls); e.failed += num(r.failed);
        e.tokens_in += num(r.tin); e.tokens_out += num(r.tout); e.no_usage += num(r.no_usage);
      }
      // depth histogram: attempts per call (key-rotation retries included — it counts
      // HTTP attempts, which is what the digest labels "retries"). Rows arrive per raw
      // ladder name, so after the alias merge two raw names can map to one (depth, ladder)
      // bucket — sum, don't push duplicates (the reporter sums by depth anyway, but a
      // clean histogram keeps the payload self-describing).
      for (const r of depthRows) {
        const e = entry(r.ladder);
        const depth = num(r.depth), calls = num(r.calls);
        const hit = e.depth.find(x => x.depth === depth);
        if (hit) hit.calls += calls;
        else e.depth.push({ depth, calls });
      }
      const rungGroups = new Map();
      for (const r of rungRows) {
        const ladder = canonName(r.ladder); // alias-merge rung rows the same way as agg rows
        const model = r.model || null;
        const key = `${ladder}|${model}`;
        let e = rungGroups.get(key);
        if (!e) { e = { ladder, model, category: categoryOf(model), calls: 0, tokens_in: 0, tokens_cached: 0, tokens_out: 0 }; rungGroups.set(key, e); }
        e.calls += num(r.calls); e.tokens_in += num(r.tin); e.tokens_cached += num(r.tcached); e.tokens_out += num(r.tout);
      }
      for (const e of rungGroups.values()) e.cost_usd = costUsd(e.model, e.tokens_in, e.tokens_cached, e.tokens_out);
      const rungsByLadder = new Map();
      for (const e of rungGroups.values()) {
        if (!rungsByLadder.has(e.ladder)) rungsByLadder.set(e.ladder, []);
        rungsByLadder.get(e.ladder).push(e);
      }
// Hourly cut (#93): one row per UTC hour × ladder × model, with cost — the owner's
      // "master-plan-mimo: $X" view. Merged by canonical name: 'deepseek', 'deepseek:build'
      // and 'service' are the same ladder and must land in ONE row per hour.
      const hourlyGroups = new Map();
      for (const r of hourlyRows) {
        const hour = r.hour, ladder = canonName(r.ladder), model = r.model || null;
        const key = `${hour}|${ladder}|${model}`;
        let e = hourlyGroups.get(key);
        if (!e) { e = { hour, ladder, model, category: categoryOf(model), calls: 0, ok: 0, tokens_in: 0, tokens_cached: 0, tokens_out: 0 }; hourlyGroups.set(key, e); }
        e.calls += num(r.calls); e.ok += num(r.ok_n);
        e.tokens_in += num(r.tin); e.tokens_cached += num(r.tcached); e.tokens_out += num(r.tout);
      }
      const hourly = [...hourlyGroups.values()].map((e) => ({ ...e, cost_usd: costUsd(e.model, e.tokens_in, e.tokens_cached, e.tokens_out) }));
      const totals = { calls: 0, failed: 0, tokens_in: 0, tokens_out: 0, no_usage: 0, cost_usd: 0 };
      const out = [...ladders.values()].sort((a, b) => b.calls - a.calls);
      for (const e of out) {
        e.depth.sort((a, b) => a.depth - b.depth);
        e.rungs = rungsByLadder.get(e.ladder) || [];
        e.cost_usd = e.rungs.reduce((s, r) => s + (r.cost_usd || 0), 0);
        for (const k of Object.keys(totals)) totals[k] += e[k];
      }
      // Top errors, merged across all ladders: normalize first (digits masked), then
      // re-sum — 'can only afford 499' / '776' become one row. Top 20 with headroom;
      // the digest shows top 5. Rows arrive already frequency-ordered, but the merge
      // can promote a variant, so re-sort after grouping.
      const errGroups = new Map();
      for (const r of errRows) {
        const key = normalizeError(r.err);
        errGroups.set(key, (errGroups.get(key) || 0) + num(r.n));
      }
      const errors = [...errGroups.entries()]
        .map(([error, calls]) => ({ error, calls }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 20);
      return json(200, { hours, since_ms: since, generated_ms: Date.now(), totals, ladders: out, hourly, errors });
    } catch (e) {
      return oaError(500, `analytics query failed: ${e.message}`, 'server_error');
    }
  }

  // Ops: unpark all Go keys and Go rungs (a wrongly parked key, a limit lifted early).
  if (request.method === 'POST' && url.pathname === '/v1/state/reset-keys') {
    const st = store || makeStore(env);
    await st.resetKeys();
    return json(200, await st.snapshot());
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body;
    try { body = await request.json(); } catch { return oaError(400, 'bad json', 'invalid_request_error'); }
    if (!body || !Array.isArray(body.messages) || !body.messages.length) return oaError(400, 'messages required', 'invalid_request_error');
    const { ladder_timeout_ms: perRung, ladder_total_timeout_ms: total, ladder_ttfb_ms: ttfb, ladder_rung: pinRung, ladder_conversation: _ladderConversation, ...chat } = body;
    if (!chat.model) chat.model = DEFAULT_LADDER;
    const conversation = await conversationKey(request, body, env);
    // OpenRouter app attribution (#33): which of our tools eats this call, for the OpenRouter
    // "Application" analytics cut. Both values are sanitised here (slug → [a-z0-9-]{1,64},
    // default 'llm-ladder') so the ladder itself only ever sees clean values.
    const appSlug = sanitizeAppSlug(request.headers.get('x-ladder-app'));
    const appTitle = sanitizeAppTitle(request.headers.get('x-ladder-app-title'));
    const started = Date.now();
    const r = await run(chat, {
      env, config, store: store || makeStore(env), fetchImpl,
      timeoutMs: Math.min(Number(perRung) || 20000, 60000),
      totalTimeoutMs: Number(total) ? Math.min(Number(total), 120000) : null,
      ...(Number(ttfb) ? { ttfbMs: Math.min(Number(ttfb), 60000) } : {}),
      ...(pinRung ? { pinRung: String(pinRung) } : {}),
      conversation, appSlug, appTitle,
    });
    const pinTag = conversation ? ` pin=${r.pin || 'none'}` : '';
    const attemptsHeader = r.attempts.map(a => `${a.model}=${a.outcome}`).join(', ').slice(0, 900);
    const attemptsHeaderWithPin = conversation ? attemptsHeader + `, pin=${r.pin || 'none'}` : attemptsHeader;
    const trace = makeTrace(request);
    // usage: non-stream answers only (stream usage arrives after the relay → D1 trace has the same gap, #22).
    console.log(JSON.stringify({ ladder: chat.model, ok: r.ok, model: r.model || null, app: appSlug, ms: Date.now() - started, usage: (r.data && r.data.usage) || null, conversation: conversation ? conversation.slice(0, 8) : null, pin: r.pin || null, attempts: r.attempts, trace }));
    await logCall(env, trace, chat.model, r, started);
    if (!r.ok) return oaError(r.status, r.error, 'ladder_error', { attempts: r.attempts }, { 'x-ladder-attempts': attemptsHeaderWithPin });
    if (r.stream) {
      return new Response(r.stream, { status: 200, headers: {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache',
        'x-ladder-model': r.model, 'x-ladder-attempts': attemptsHeaderWithPin,
      } });
    }
    const out = { ...r.data, model: r.model };
    return json(200, out, { 'x-ladder-model': r.model, 'x-ladder-attempts': attemptsHeaderWithPin });
  }

  return oaError(404, 'not found', 'invalid_request_error');
}