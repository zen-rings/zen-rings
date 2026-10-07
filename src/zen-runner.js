// Zen Runner — control plane for the free-model self-tests.
//
// One job, four jobs at once:
//   1. decide whether a model may be called AT ALL right now (quarantine with an exponential
//      ladder, so a dead provider is not poked 100 times per run);
//   2. hold the budget (50/min and 700/day per runner repo — the real quota is per (egress IP,
//      model), and a repository IS an egress IP);
//   3. dispatch the GitHub Actions run round-robin across the registry, each with its own token;
//   4. tell the caller exactly why something was refused (202/401/409/413/429/502/503).
//
// The model is NEVER chosen here: the caller names it explicitly. Choosing would mean the
// controller silently substituting a paid rung for a dead free one — the exact incident that
// produced this service (#86).
//
// Dependency-free of the Workerd runtime (same rule as handler.js) so `node --test` runs it.

const DISPATCH_TIMEOUT_MS = 10_000;
const BODY_MAX_BYTES = 8 * 1024;
const MODEL_RE = /^[A-Za-z0-9._:@/-]{1,120}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._-]{1,80}$/;

// Owner's numbers, with headroom under the measured ~90-95/min and ~940/day per (IP, model)
// (docs/free-tier-limits.md). 700 is the per-MODEL day cap: providers are counted apart, because
// their quotas are apart — MiMo spending its day must not refuse Nemotron (see sharedDayCap).
export const LIMITS = { perMin: 50, perDay: 700 };
// `down` = the provider keeps saying the same thing (measured: 22 identical 500s in a row).
// Silence for hours is correct there. `flaky` = alive but unreliable (measured: fledge-alpha-free
// at ~9%) — it must be re-checked often, because every check can catch a working window.
export const LADDERS = {
  down: [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000],
  flaky: [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000],
};
export const OK_INTERVAL_MS = 6 * 3_600_000;
const HARD_KINDS = new Set(['error', 'fingerprint']);   // provider/model is broken
const SOFT_KINDS = new Set(['rate', 'provider', 'daily', 'timeout']); // quota/transient
const DOWN_AFTER = 3;

const j = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a); const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const bearer = (request) => {
  const raw = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
};

export const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

// ---------------------------------------------------------------- pure logic (unit-tested)

export function nextCheckAt({ status = 'unknown', failures = 0 }, now = Date.now()) {
  if (status === 'ok') return now + OK_INTERVAL_MS;
  const down = status === 'down';
  const ladder = down ? LADDERS.down : LADDERS.flaky;
  // `down` starts at step 0 the moment the verdict is reached (DOWN_AFTER failures in), so the
  // first silence is 30 min and each further failed re-check walks one step deeper.
  const step = ladder[Math.min(Math.max(failures - (down ? DOWN_AFTER : 1), 0), ladder.length - 1)];
  return now + step;
}

// One report -> the next state of the model. Success resets everything; a soft kind (quota,
// timeout) is flaky by definition; a hard kind walks the ladder and tips into `down` once the
// same kind has repeated DOWN_AFTER times — the "5 одинаковых ошибок подряд" rule, measured on
// jev-1.13-free (22/22 identical 500s).
export function applyReport(prev, report, now = Date.now()) {
  const before = { status: prev?.status || 'unknown', failures: prev?.failures || 0, kind: prev?.last_error_kind || null };
  if (report.ok) {
    return {
      status: 'ok', failures: 0, successes: (prev?.successes || 0) + 1,
      last_ok_at: now, first_failed_at: prev?.first_failed_at ?? null,
      last_error: null, last_error_kind: null, next_check_at: now + OK_INTERVAL_MS, updated_at: now,
    };
  }
  const kind = String(report.kind || 'error').slice(0, 40);
  const sameAsBefore = before.kind === kind;
  const failures = before.failures + 1;
  const hard = HARD_KINDS.has(kind) && (sameAsBefore || before.failures === 0);
  const soft = SOFT_KINDS.has(kind);
  const status = hard && failures >= DOWN_AFTER ? 'down' : 'flaky';
  return {
    status, failures,
    successes: prev?.successes || 0,
    last_ok_at: prev?.last_ok_at ?? null,
    first_failed_at: prev?.first_failed_at ?? now,
    last_error: String(report.error || '').slice(0, 300) || null,
    last_error_kind: kind,
    // A quota answer or a timeout never walks the ladder: those are re-checked in a minute. Only
    // a provider that keeps failing the same hard way buys silence.
    next_check_at: soft ? now + LADDERS.flaky[0] : nextCheckAt({ status, failures }, now),
    updated_at: now,
  };
}

// Rolling-minute + UTC-day counters. Returns the verdict BEFORE anything is dispatched.
export function budgetVerdict(counts, now = Date.now(), limits = LIMITS) {
  const day = utcDay(now);
  const minuteFresh = counts.minute_at && now - counts.minute_at < 60_000;
  const minute = minuteFresh ? counts.minute_count : 0;
  const dayCount = counts.day === day ? counts.day_count : 0;
  if (minute >= limits.perMin) {
    return { ok: false, reason: 'minute', retry_after: Math.max(1_000, 60_000 - (now - counts.minute_at)) };
  }
  if (dayCount >= limits.perDay) {
    const t = Number(now);
    const midnight = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate() + 1);
    return { ok: false, reason: 'day', retry_after: Math.max(1_000, midnight - t) };
  }
  return { ok: true, minute, day: dayCount };
}

// The shared counter ('*','*') exists to catch "nobody counted this call", not to ration the day.
// The quota is per (egress IP, model) and providers are counted apart, so a shared DAILY cap equal
// to one model's cap made every provider share one allowance: MiMo spending its day refused Nemotron
// with its own budget untouched. The shared day cap is therefore perDay × (the per-model counters
// that moved today + 1) — by construction never tighter than the sum of the independent allowances,
// and the +1 is the room a provider that has not called yet needs to be counted at all. Several
// repos of the same model only make this backstop more generous, never tighter; that is the safe
// direction for a runaway brake.
// The shared MINUTE cap stays as it is: a rate limit that spans providers is real (OpenRouter :free
// = 20/min per account), a per-day sum of independent quotas is not.
export async function sharedDayCap(env, now = Date.now(), perDay = LIMITS.perDay) {
  const day = utcDay(now);
  let buckets = 0;
  try {
    buckets = (await env.ZEN_DB.prepare('SELECT COUNT(*) AS n FROM zen_budget WHERE model <> ?1 AND day = ?2')
      .bind('*', day).first())?.n ?? 0;
  } catch { buckets = 0; }
  return perDay * (Math.max(0, Number(buckets) || 0) + 1);
}

// Round-robin over enabled repos. A repo that failed `failures` times in a row is skipped
// (its token is dead or its Actions are disabled) but keeps its place in the ring.
export function pickNextRepo(repos, cursor = 0, skip = new Set()) {
  const live = repos.filter((r) => r.enabled && !skip.has(r.repo));
  if (!live.length) return null;
  const i = ((cursor % live.length) + live.length) % live.length;
  return { repo: live[i].repo, row: live[i], cursor: (i + 1) % live.length, size: live.length };
}

// ---------------------------------------------------------------- token storage

export async function encryptToken(plain, keyB64) {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plain);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  let bin = '';
  for (const b of [...iv, ...ct]) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function decryptToken(enc, keyB64) {
  const key = await importKey(keyB64);
  const bin = atob(enc);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return new TextDecoder().decode(plain);
}

async function importKey(keyB64) {
  if (!keyB64) throw new Error('ZEN_TOKEN_KEY not configured');
  const raw = Uint8Array.from(atob(String(keyB64).trim()), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('ZEN_TOKEN_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// token_ref = 'env:NAME' reuses a token that already lives in a worker secret, so the registry
// can hold the pool repo without anyone ever writing that token down twice.
export async function resolveToken(row, env) {
  if (row.token_ref) {
    const name = String(row.token_ref).replace(/^env:/, '').trim();
    return env[name] ? String(env[name]).trim() : null;
  }
  if (row.token_enc) return decryptToken(row.token_enc, env.ZEN_TOKEN_KEY);
  return null;
}

// ---------------------------------------------------------------- D1 helpers

const db = (env) => env.ZEN_DB;
const nowMs = (env) => Number(env.ZEN_NOW_MS) || Date.now();

export async function readCounts(env, scope, model) {
  const row = await db(env).prepare('SELECT * FROM zen_budget WHERE scope = ?1 AND model = ?2')
    .bind(scope, model).first();
  return row || { scope, model, minute_count: 0, minute_at: 0, day_count: 0, day: '' };
}

export async function bumpCount(env, scope, model, now) {
  const day = utcDay(now);
  // One statement: reset the rolling minute if the window expired, reset the day if the date
  // changed, then increment. Doing it in JS first would race two concurrent dispatches.
  await db(env).prepare(
    `INSERT INTO zen_budget (scope, model, minute_count, minute_at, day_count, day)
     VALUES (?1, ?2, 1, ?3, 1, ?4)
     ON CONFLICT(scope, model) DO UPDATE SET
       minute_count = CASE WHEN ?3 - minute_at >= 60000 THEN 1 ELSE minute_count + 1 END,
       minute_at   = CASE WHEN ?3 - minute_at >= 60000 THEN ?3 ELSE minute_at END,
       day_count   = CASE WHEN day = ?4 THEN day_count + 1 ELSE 1 END,
       day         = ?4`
  ).bind(scope, model, now, day).run();
}

export async function readModel(env, model) {
  return await db(env).prepare('SELECT * FROM zen_models WHERE model = ?1').bind(model).first();
}

export async function writeModel(env, model, state) {
  await db(env).prepare(
    `INSERT INTO zen_models (model, status, failures, successes, last_error, last_error_kind, last_ok_at, first_failed_at, next_check_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(model) DO UPDATE SET status=?2, failures=?3, successes=?4, last_error=?5,
       last_error_kind=?6, last_ok_at=?7, first_failed_at=?8, next_check_at=?9, updated_at=?10`
  ).bind(model, state.status, state.failures, state.successes, state.last_error, state.last_error_kind,
    state.last_ok_at, state.first_failed_at, state.next_check_at, state.updated_at).run();
}

const runId = (env) => `${nowMs(env).toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

export async function authorized(request, env) {
  const want = env.ZEN_RUNNER_TOKEN;
  if (!want) return { ok: false, status: 503, reason: 'controller not configured (ZEN_RUNNER_TOKEN missing)' };
  const got = bearer(request);
  if (!got || !timingSafeEqual(got, String(want).trim())) return { ok: false, status: 401, reason: 'unauthorized' };
  return { ok: true };
}

// Two levels of trust, deliberately not the same secret. ZEN_RUNNER_TOKEN is the low-privilege one:
// it is provisioned into EVERY ring repository, so anything that can read one ring repo's CI secrets
// can call /zen/run and spend the quota — and nothing more. ZEN_RING_ADMIN_TOKEN never leaves this
// repository and the owner's terminal: it opens the registry for writing and the provisioning
// payload, which carries the plaintext ring tokens. One token for both jobs would mean a compromised
// ring repo could read every private repo's PAT.
export async function authorizedAdmin(request, env) {
  const want = env.ZEN_RING_ADMIN_TOKEN;
  if (!want) return { ok: false, status: 503, reason: 'ring admin not configured (ZEN_RING_ADMIN_TOKEN missing)' };
  const got = bearer(request);
  if (!got || !timingSafeEqual(got, String(want).trim())) return { ok: false, status: 401, reason: 'unauthorized' };
  return { ok: true };
}

// ---------------------------------------------------------------- routes

export async function zenHealth(request, env) {
  const cfg = {
    db: !!env.ZEN_DB,
    repos: 0,
    models: 0,
    per_min: Number(env.ZEN_PER_MIN) || LIMITS.perMin,
    per_day: Number(env.ZEN_PER_DAY) || LIMITS.perDay,
  };
  if (env.ZEN_DB) {
    try {
      cfg.repos = (await env.ZEN_DB.prepare('SELECT COUNT(*) AS n FROM zen_repos WHERE enabled = 1').first())?.n ?? 0;
      cfg.models = (await env.ZEN_DB.prepare('SELECT COUNT(*) AS n FROM zen_models').first())?.n ?? 0;
    } catch (e) { cfg.error = String(e?.message || e).slice(0, 120); }
  }
  return j(200, { service: 'zen-runner', ok: true, ...cfg });
}

// GET /zen/models — the "табличка": for every model, whether to call it now and when to return.
export async function zenModels(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const now = nowMs(env);
  const rows = await env.ZEN_DB.prepare('SELECT * FROM zen_models ORDER BY status DESC, model').all();
  const out = (rows.results || []).map((r) => ({
    model: r.model, status: r.status, failures: r.failures, successes: r.successes,
    verdict: r.next_check_at > now ? 'skip' : 'run',
    next_check_at: r.next_check_at, next_check_in: Math.max(0, r.next_check_at - now),
    last_error: r.last_error, last_error_kind: r.last_error_kind, last_ok_at: r.last_ok_at,
  }));
  return j(200, { now, models: out, limits: { per_min: Number(env.ZEN_PER_MIN) || LIMITS.perMin, per_day: Number(env.ZEN_PER_DAY) || LIMITS.perDay } });
}

// POST /zen/run { model, runs? } — the caller names the model; we only decide whether it may go.
export async function zenRun(request, env, fetchImpl = fetch) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > BODY_MAX_BYTES) return j(413, { error: 'body too large' });
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const model = String(body?.model || '');
  if (!MODEL_RE.test(model)) return j(400, { error: 'model is required (explicit id, e.g. "qwen3-235b-a22b-thinking-2507-free")' });
  const runs = Math.min(Math.max(Number(body?.runs) || 1, 1), 20);
  const now = nowMs(env);

  const state = await readModel(env, model);
  if (state && state.next_check_at > now) {
    return j(409, { error: 'model is in quarantine', verdict: 'skip', status: state.status,
      next_check_at: state.next_check_at, retry_after: state.next_check_at - now,
      hint: 'provider keeps failing this model — calling again now only burns quota' });
  }

  const repos = (await env.ZEN_DB.prepare('SELECT * FROM zen_repos WHERE enabled = 1 ORDER BY added_at, repo').all()).results || [];
  if (!repos.length) return j(503, { error: 'no enabled runner repository', hint: 'POST /zen/repos {repo, token|token_ref}' });
  const cursorRow = await env.ZEN_DB.prepare("SELECT v FROM zen_meta WHERE k = 'repo_cursor'").first();
  const cursor = Number(cursorRow?.v) || 0;
  const pick = pickNextRepo(repos, cursor);
  if (!pick) return j(503, { error: 'no usable runner repository' });

  // Budget: the pair (repo, model) is the real quota and the day cap there is per model; '*' is only
  // the runaway brake, so its day cap is the sum of the independent allowances (sharedDayCap).
  const perRepo = budgetVerdict(await readCounts(env, pick.repo, model), now,
    { perMin: Number(env.ZEN_PER_MIN) || LIMITS.perMin, perDay: Number(env.ZEN_PER_DAY) || LIMITS.perDay });
  const perAll = budgetVerdict(await readCounts(env, '*', '*'), now,
    { perMin: Number(env.ZEN_PER_MIN) || LIMITS.perMin, perDay: await sharedDayCap(env, now, Number(env.ZEN_PER_DAY) || LIMITS.perDay) });
  for (const v of [perRepo, perAll]) {
    if (!v.ok) return j(429, { error: `budget exhausted (${v.reason})`, reason: v.reason, retry_after: v.retry_after, repo: pick.repo });
  }

  const token = await resolveToken(pick.row, env);
  if (!token) return j(503, { error: 'runner repository has no usable token', repo: pick.repo });

  const id = runId(env);
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${pick.repo}/dispatches`, {
      method: 'POST',
      headers: { authorization: `token ${token}`, 'content-type': 'application/json',
        accept: 'application/vnd.github+json', 'user-agent': 'zen-rings' },
      body: JSON.stringify({ event_type: 'zen-run', client_payload: { run_id: id, model, runs, location: pick.row.location || '', requested_at: new Date(now).toISOString() } }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.log(JSON.stringify({ route: 'zen/run', ok: false, model, repo: pick.repo, err: e?.name || 'Error', ms: Date.now() - started }));
    return j(502, { error: 'dispatch_failed', gh_status: null, repo: pick.repo });
  }
  console.log(JSON.stringify({ route: 'zen/run', ok: res.ok, model, repo: pick.repo, gh_status: res.status, ms: Date.now() - started }));
  if (!res.ok) return j(502, { error: 'dispatch_failed', gh_status: res.status, repo: pick.repo });

  await bumpCount(env, pick.repo, model, now);
  await bumpCount(env, '*', '*', now);
  await env.ZEN_DB.prepare('INSERT INTO zen_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind('repo_cursor', String(pick.cursor)).run();
  await env.ZEN_DB.prepare('UPDATE zen_repos SET last_dispatch_at = ?1 WHERE repo = ?2').bind(now, pick.repo).run();
  await env.ZEN_DB.prepare('INSERT INTO zen_runs (id, model, repo, location, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id, model, pick.repo, pick.row.location || '', 'dispatched', now).run();
  return j(202, { run_id: id, model, repo: pick.repo, location: pick.row.location || '', runs, ring_size: pick.size });
}

// POST /zen/report { run_id?, model, ok, kind?, error? } — what the runner saw. This is the only
// way the quarantine learns: without it the table stays empty and every model looks unknown.
export async function zenReport(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const model = String(body?.model || '');
  if (!MODEL_RE.test(model)) return j(400, { error: 'model is required' });
  const now = nowMs(env);
  const prev = await readModel(env, model);
  const state = applyReport(prev, { ok: !!body?.ok, kind: body?.kind, error: body?.error }, now);
  await writeModel(env, model, state);
  if (body?.run_id) {
    await env.ZEN_DB.prepare('UPDATE zen_runs SET status = ?1, ok = ?2, error = ?3, answer = ?4, reported_at = ?5 WHERE id = ?6')
      .bind('reported', body?.ok ? 1 : 0, state.last_error, String(body?.answer || '').slice(0, 4000), now, String(body.run_id)).run();
  }
  return j(200, { model, ...state, next_check_in: Math.max(0, state.next_check_at - now) });
}

// POST /zen/repos { repo, token? | token_ref?, enabled?, location? } — the registry, i.e. THE source
// of truth for "which repositories are in the ring and with which token". `token` is stored
// encrypted (AES-GCM, ZEN_TOKEN_KEY) and never returned or logged; `token_ref: "env:NAME"` points at
// a token that already lives in a worker secret. Admin token only — rewriting the ring is not a
// thing a ring member may do for itself.
export async function zenRepos(request, env) {
  const auth = await authorizedAdmin(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const repo = String(body?.repo || '').trim();
  if (!REPO_RE.test(repo)) return j(400, { error: 'repo must be "owner/name"' });
  const enabled = body?.enabled === false ? 0 : 1;
  const location = String(body?.location ?? '').slice(0, 8);
  const now = nowMs(env);
  let tokenEnc = null; let tokenRef = body?.token_ref ? String(body.token_ref).slice(0, 120) : null;
  if (body?.token) {
    if (!env.ZEN_TOKEN_KEY) return j(503, { error: 'ZEN_TOKEN_KEY not configured — refusing to store a plaintext token' });
    tokenEnc = await encryptToken(String(body.token), env.ZEN_TOKEN_KEY);
    tokenRef = null;
  }
  if (!tokenEnc && !tokenRef) {
    const prev = await env.ZEN_DB.prepare('SELECT token_enc, token_ref FROM zen_repos WHERE repo = ?1').bind(repo).first();
    tokenEnc = prev?.token_enc ?? null; tokenRef = prev?.token_ref ?? null;
  }
  await env.ZEN_DB.prepare(
    `INSERT INTO zen_repos (repo, token_enc, token_ref, enabled, location, failures, disabled_reason, added_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6)
     ON CONFLICT(repo) DO UPDATE SET token_enc = COALESCE(?2, token_enc), token_ref = ?3,
       enabled = ?4, location = ?5, disabled_reason = CASE WHEN ?4 = 1 THEN NULL ELSE disabled_reason END`
  ).bind(repo, tokenEnc, tokenRef, enabled, location, now).run();
  const rows = (await env.ZEN_DB.prepare('SELECT repo, enabled, location, token_ref, (token_enc IS NOT NULL) AS has_token, last_dispatch_at FROM zen_repos ORDER BY added_at, repo').all()).results || [];
  return j(200, { ok: true, repo, repos: rows });
}

// GET /zen/ring/repos — the same registry for a human: no token, not even a hint of one.
export async function zenRingRepos(request, env) {
  const auth = await authorizedAdmin(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const rows = (await env.ZEN_DB.prepare('SELECT repo, enabled, location, token_ref, (token_enc IS NOT NULL) AS has_token, last_dispatch_at FROM zen_repos ORDER BY added_at, repo').all()).results || [];
  return j(200, { source: 'cf-d1', repos: rows.map((r) => ({ ...r, enabled: !!r.enabled })) });
}

// GET /zen/ring/payload — the provisioning list WITH the tokens, decrypted here, in the worker, on
// request. This is what replaced the ZEN_RING_PAYLOAD GitHub secret: the ring lives in this
// database, so provisioning reads it from the same place that dispatches the runs — no second copy
// in GitHub, no Google Sheet, no agent in the loop.
//
// The response carries plaintext PATs, so: admin token only (never provisioned into a ring repo),
// `no-store` so no cache keeps a copy, and the log line below holds counts only.
export async function zenRingPayload(request, env) {
  const auth = await authorizedAdmin(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const rows = (await env.ZEN_DB.prepare('SELECT * FROM zen_repos ORDER BY added_at, repo').all()).results || [];
  const repos = [];
  for (const r of rows) {
    const row = { repo: r.repo, location: r.location || '', enabled: !!r.enabled };
    if (r.token_ref) {
      // `env:NAME` rows keep the reference — that is what must be written back, or the row would
      // freeze one copy of a secret that is meant to be rotated in place. `resolved_token` is for
      // provisioning only and is never posted back.
      row.token_ref = r.token_ref;
      row.resolved_token = await resolveToken({ token_ref: r.token_ref }, env);
    }
    if (r.token_enc) {
      try { row.token = await decryptToken(r.token_enc, env.ZEN_TOKEN_KEY); }
      catch (e) { row.token_error = `cannot decrypt: ${String(e?.message || e).slice(0, 80)}`; }
    }
    repos.push(row);
  }
  console.log(JSON.stringify({
    route: 'zen/ring/payload', rows: repos.length,
    with_token: repos.filter((r) => r.token || r.resolved_token).length,
    unusable: repos.filter((r) => !r.token && !r.resolved_token).map((r) => r.repo),
  }));
  return j(200, { source: 'cf-d1', repos }, { 'cache-control': 'no-store' });
}

// Cron sweep (every 15 min): re-check at most ZEN_SWEEP_MAX quarantined models whose backoff has
// expired. This is what makes the exponential ladder self-healing — nobody has to poke the dead
// ones by hand, and the budget check below means a sweep can never overrun the caps.
export async function zenSweep(env, fetchImpl = fetch) {
  if (!env.ZEN_DB) return { ok: false, error: 'zen database not configured' };
  const now = nowMs(env);
  const max = Number(env.ZEN_SWEEP_MAX) || 3;
  const due = (await env.ZEN_DB.prepare(
    'SELECT model FROM zen_models WHERE next_check_at <= ?1 AND status != ?2 ORDER BY next_check_at LIMIT ?3'
  ).bind(now, 'ok', max).all()).results || [];
  if (!due.length) return { ok: true, checked: 0 };
  const out = [];
  for (const { model } of due) {
    const req = new Request('https://l.test/zen/run', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.ZEN_RUNNER_TOKEN || ''}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, runs: 1 }),
    });
    const res = await zenRun(req, env, fetchImpl);
    out.push({ model, status: res.status });
    await env.ZEN_DB.prepare('UPDATE zen_models SET next_check_at = ?1 WHERE model = ?2').bind(now + 10 * 60_000, model).run();
  }
  console.log(JSON.stringify({ route: 'zen/sweep', checked: out.length, out }));
  return { ok: true, checked: out.length, out };
}

// GET /zen/result/{run_id} — the answer text for one run, so the caller never has to read
// the run log. 404 = unknown id or nothing reported yet.
export async function zenResult(request, env, runId) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const row = await env.ZEN_DB.prepare(
    'SELECT id, model, repo, status, ok, error, answer, created_at, reported_at FROM zen_runs WHERE id = ?1'
  ).bind(String(runId)).first();
  if (!row) return j(404, { error: 'run not found' });
  return j(200, row);
}