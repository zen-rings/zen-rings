import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';
import {
  nextCheckAt, applyReport, budgetVerdict, pickNextRepo, encryptToken, decryptToken, LIMITS, LADDERS,
} from '../src/zen-runner.js';

const ENV = { ZEN_RUNNER_TOKEN: 'zen-tok', ZEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64') };
const NOW = Date.UTC(2026, 9, 4, 10, 0, 0);
const auth = { authorization: 'Bearer zen-tok' };
const ADMIN = { authorization: 'Bearer ring-admin-tok' };
const ADMIN_ENV = { ZEN_RING_ADMIN_TOKEN: 'ring-admin-tok' };

// In-memory D1 double: enough of the real semantics for the control plane (the budget upsert is
// emulated faithfully — stale rolling minute resets, new UTC day resets) so the endpoint can be
// exercised end to end without a worker.
function fakeD1(seed = {}) {
  const models = new Map((seed.models || []).map((m) => [m.model, m]));
  const budget = new Map((seed.budget || []).map((b) => [`${b.scope}|${b.model}`, b]));
  const repos = [...(seed.repos || [])];
  const meta = new Map(Object.entries(seed.meta || {}));
  const runs = new Map();
  const sqls = [];
  const day = (now) => new Date(now).toISOString().slice(0, 10);

  const api = {
    _sqls: sqls, _models: models, _budget: budget, _repos: repos, _meta: meta, _runs: runs,
    prepare(sql) {
      let bound = [];
      const stmt = {
        first: async () => first(sql, bound),
        all: async () => ({ results: all(sql, bound) }),
        run: async () => { run_(sql, bound); return { success: true }; },
        bind(...p) {
          bound = p;
          sqls.push({ sql, params: p });
          return stmt;
        },
      };
      return stmt;
    },
  };

  function first(sql, p) {
    if (/FROM zen_models WHERE model = \?1/.test(sql)) return models.get(p[0]) || null;
    if (/FROM zen_budget WHERE scope/.test(sql)) return budget.get(`${p[0]}|${p[1]}`) || null;
    if (/FROM zen_meta WHERE k = 'repo_cursor'/.test(sql)) return meta.has('repo_cursor') ? { v: meta.get('repo_cursor') } : null;
    if (/FROM zen_runs WHERE id = \?1/.test(sql)) return runs.get(p[0]) || null;
    if (/COUNT\(\*\) AS n FROM zen_repos WHERE enabled = 1/.test(sql)) return { n: repos.filter((r) => r.enabled).length };
    if (/COUNT\(\*\) AS n FROM zen_models/.test(sql)) return { n: models.size };
    if (/SELECT repo, enabled/.test(sql)) return null;
    return null;
  }
  function all(sql, p) {
    if (/SELECT \* FROM zen_models ORDER BY/.test(sql)) return [...models.values()];
    if (/SELECT \* FROM zen_models WHERE next_check_at <= \?1/.test(sql)) {
      const [now, status, max] = p;
      return [...models.values()].filter((m) => m.next_check_at <= now && m.status !== status).slice(0, max);
    }
    if (/SELECT \* FROM zen_repos WHERE enabled = 1 ORDER BY/.test(sql)) return repos.filter((r) => r.enabled);
    if (/SELECT \* FROM zen_repos ORDER BY/.test(sql)) {
      return [...repos].sort((a, b) => (a.added_at || 0) - (b.added_at || 0) || a.repo.localeCompare(b.repo));
    }
    if (/SELECT repo, enabled, location, token_ref/.test(sql)) {
      // Project the named columns only, exactly like D1: a spread of the whole row here would let a
      // test pass on a listing that leaks token_enc in production.
      return repos.map((r) => ({
        repo: r.repo, enabled: r.enabled, location: r.location, token_ref: r.token_ref,
        has_token: !!r.token_enc, last_dispatch_at: r.last_dispatch_at,
      }));
    }
    if (/SELECT token_enc, token_ref FROM zen_repos WHERE repo = \?1/.test(sql)) {
      const r = repos.find((x) => x.repo === p[0]);
      return r ? [{ token_enc: r.token_enc, token_ref: r.token_ref }] : [];
    }
    return [];
  }
  function run_(sql, p) {
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
      return;
    }
    if (/INSERT INTO zen_models/.test(sql)) {
      const [model, status, failures, successes, err, kind, okAt, firstFailed, next, updated] = p;
      models.set(model, { model, status, failures, successes, last_error: err, last_error_kind: kind,
        last_ok_at: okAt, first_failed_at: firstFailed, next_check_at: next, updated_at: updated });
      return;
    }
    if (/INSERT INTO zen_meta/.test(sql)) { meta.set(p[0], p[1]); return; }
    if (/UPDATE zen_repos SET last_dispatch_at/.test(sql)) {
      const r = repos.find((x) => x.repo === p[1]); if (r) r.last_dispatch_at = p[0];
      return;
    }
    if (/INSERT INTO zen_repos/.test(sql)) {
      const [repo, enc, ref, enabled, location, added] = p;
      const prev = repos.find((x) => x.repo === repo);
      if (prev) { prev.token_enc = enc ?? prev.token_enc; prev.token_ref = ref; prev.enabled = enabled; prev.location = location; }
      else repos.push({ repo, token_enc: enc, token_ref: ref, enabled, location, added_at: added, failures: 0 });
      return;
    }
    if (/INSERT INTO zen_runs/.test(sql)) {
      runs.set(p[0], { id: p[0], model: p[1], repo: p[2], location: p[3], status: p[4], created_at: p[5] });
      return;
    }
    if (/UPDATE zen_runs SET status/.test(sql)) { const r = runs.get(p[5]); if (r) { r.status = p[0]; r.ok = p[1]; r.answer = p[3]; } return; }
    if (/UPDATE zen_models SET next_check_at/.test(sql)) { const m = models.get(p[1]); if (m) m.next_check_at = p[0]; return; }
  }
  return api;
}

const env = (d1, extra = {}) => ({ ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, ...extra });
const post = (path, body, d1, extra = {}) =>
  handle(new Request(`https://l.test${path}`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1, extra), { fetchImpl: fakeGh() });
const get = (path, d1, headers = auth) =>
  handle(new Request(`https://l.test${path}`, { headers }), env(d1));

function fakeGh({ status = 204, throws = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (throws) throw new Error('network');
    return new Response(null, { status });  // 204 takes a null body
  };
  fn.calls = calls;
  return fn;
}

// ------------------------------------------------------------------ pure logic

test('nextCheckAt: ok = 6h, flaky ladder 1m→5m→15m→30m, down 30m→2h→6h→24h', () => {
  assert.equal(nextCheckAt({ status: 'ok', failures: 0 }, NOW) - NOW, 6 * 3_600_000);
  assert.deepEqual([1, 2, 3, 9].map((f) => nextCheckAt({ status: 'flaky', failures: f }, NOW) - NOW),
    [60_000, 300_000, 900_000, 1_800_000]);
  // `down` is reached at 3 identical failures, so the ladder starts there and walks deeper on
  // every failed re-check instead of jumping straight to 6h.
  assert.deepEqual([3, 4, 5, 8].map((f) => nextCheckAt({ status: 'down', failures: f }, NOW) - NOW),
    [LADDERS.down[0], LADDERS.down[1], LADDERS.down[2], LADDERS.down[3]], 'last step sticks');
});

test('applyReport: success resets everything; hard kind repeats → down; soft kind stays flaky', () => {
  let s = applyReport(null, { ok: true }, NOW);
  assert.equal(s.status, 'ok');
  assert.equal(s.next_check_at - NOW, 6 * 3_600_000);

  // measured case: jev-1.13-free answered 22 identical 500s — must end up silent for hours
  s = applyReport({ status: 'unknown', failures: 0, last_error_kind: null }, { ok: false, kind: 'error', error: '500' }, NOW);
  assert.equal(s.status, 'flaky', 'first hard failure is not yet a verdict');
  s = applyReport(s, { ok: false, kind: 'error', error: '500' }, NOW + 60_000);
  assert.equal(s.failures, 2);
  s = applyReport(s, { ok: false, kind: 'error', error: '500' }, NOW + 120_000);
  assert.equal(s.status, 'down', 'three identical hard failures = quarantine');
  assert.equal(s.next_check_at - (NOW + 120_000), LADDERS.down[0]);

  // measured case: fledge-alpha-free answers ~9% of the time — quota/transient never silences it
  const f = applyReport({ status: 'unknown', failures: 2, last_error_kind: 'error' }, { ok: false, kind: 'provider' }, NOW);
  assert.equal(f.status, 'flaky');
  assert.equal(f.next_check_at - NOW, LADDERS.flaky[0]);
});

test('budgetVerdict: 50/min and 500/day, rolling minute + UTC day', () => {
  assert.equal(LIMITS.perMin, 50);
  assert.equal(LIMITS.perDay, 500);
  assert.equal(budgetVerdict({ minute_count: 49, minute_at: NOW, day_count: 0, day: '2026-10-04' }, NOW).ok, true);
  const m = budgetVerdict({ minute_count: 50, minute_at: NOW, day_count: 0, day: '2026-10-04' }, NOW);
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'minute');
  assert.equal(m.retry_after, 60_000);
  const d = budgetVerdict({ minute_count: 0, minute_at: 0, day_count: 500, day: '2026-10-04' }, NOW);
  assert.equal(d.reason, 'day');
  assert.ok(d.retry_after > 0 && d.retry_after <= 86_400_000, 'retry_after points at the next UTC midnight');
  // a stale minute window and a day from yesterday both read as free
  assert.equal(budgetVerdict({ minute_count: 50, minute_at: NOW - 61_000, day_count: 500, day: '2026-10-03' }, NOW).ok, true);
});

test('pickNextRepo: strict round-robin, disabled and skipped rows are left out', () => {
  const repos = [{ repo: 'a/r1', enabled: 1 }, { repo: 'a/r2', enabled: 1 }, { repo: 'a/r3', enabled: 1 }];
  const order = [];
  let cursor = 0;
  for (let i = 0; i < 6; i++) { const p = pickNextRepo(repos, cursor); order.push(p.repo); cursor = p.cursor; }
  assert.deepEqual(order, ['a/r1', 'a/r2', 'a/r3', 'a/r1', 'a/r2', 'a/r3']);
  assert.equal(pickNextRepo([{ repo: 'a/r1', enabled: 0 }], 0), null);
  assert.equal(pickNextRepo(repos, 0, new Set(['a/r2'])).repo, 'a/r1', 'skipped repo is bypassed');
});

test('token encryption: AES-GCM round-trip, and the ciphertext is not the token', async () => {
  const key = Buffer.alloc(32, 3).toString('base64');
  const enc = await encryptToken('ghp_secret_value', key);
  assert.ok(!enc.includes('ghp_'));
  assert.equal(await decryptToken(enc, key), 'ghp_secret_value');
  await assert.rejects(() => decryptToken(enc, Buffer.alloc(32, 4).toString('base64')));
  await assert.rejects(() => encryptToken('x', 'not-base64-32-bytes'));
});

// ------------------------------------------------------------------ routes

test('/zen/* needs its own token and works before the ladder gate', async () => {
  const noAuth = await handle(new Request('https://l.test/zen/run', { method: 'POST', body: '{}' }), env(fakeD1()), {});
  assert.equal(noAuth.status, 401, 'ZEN_RUNNER_TOKEN, not LADDER_TOKEN');
  const unconfigured = await handle(new Request('https://l.test/zen/run', { method: 'POST', headers: auth, body: '{}' }),
    { ZEN_NOW_MS: NOW }, {});
  assert.equal(unconfigured.status, 503, 'missing token → 503, never a silent allow');
  const health = await handle(new Request('https://l.test/zen/health'), env(fakeD1()), {});
  assert.equal(health.status, 200, 'health needs no auth, like /pool/health');
});

test('POST /zen/run: dispatches to the next repo in the ring, rotates, and counts the budget', async () => {
  const d1 = fakeD1({ repos: [
    { repo: 'o/one', token_ref: 'env:GH_ONE', enabled: 1, location: '' },
    { repo: 'o/two', token_ref: 'env:GH_TWO', enabled: 1, location: '' },
  ] });
  const gh = fakeGh();
  const call = (body) => handle(new Request('https://l.test/zen/run', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1, { GH_ONE: 'tok-1', GH_TWO: 'tok-2' }), { fetchImpl: gh });

  const r1 = await call({ model: 'qwen3-free', runs: 2 });
  assert.equal(r1.status, 202);
  const b1 = await r1.json();
  assert.equal(b1.repo, 'o/one');
  assert.equal(b1.runs, 2);
  assert.equal(b1.ring_size, 2);

  const r2 = await call({ model: 'qwen3-free' });
  assert.equal((await r2.json()).repo, 'o/two', 'second call goes to the next repo = a different egress IP');

  assert.deepEqual(gh.calls.map((c) => c.url), [
    'https://api.github.com/repos/o/one/dispatches',
    'https://api.github.com/repos/o/two/dispatches',
  ]);
  assert.deepEqual(gh.calls[0].body, {
    event_type: 'zen-run',
    client_payload: { run_id: b1.run_id, model: 'qwen3-free', runs: 2, location: '', requested_at: new Date(NOW).toISOString() },
  });
  const pair = d1._budget.get('o/one|qwen3-free');
  assert.equal(pair.minute_count, 1);
  assert.equal(d1._budget.get('*|*').day_count, 2, 'provider-wide brake counts too');
  assert.equal(d1._runs.get(b1.run_id).status, 'dispatched');
  assert.equal(d1._meta.get('repo_cursor'), '0', 'cursor wrapped back after the last repo');
});

test('POST /zen/run: refusals are explicit — no model, quarantine, budget, GitHub error', async () => {
  const d1 = fakeD1({
    repos: [{ repo: 'o/one', token_ref: 'env:GH_ONE', enabled: 1 }],
    models: [{ model: 'dead-free', status: 'down', failures: 3, successes: 0, next_check_at: NOW + 1_800_000 }],
  });
  const call = (body, extra = {}, fetchImpl = fakeGh()) => handle(new Request('https://l.test/zen/run', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1, { GH_ONE: 'tok-1', ...extra }), { fetchImpl });

  assert.equal((await call({})).status, 400, 'the model is never chosen for the caller');
  assert.equal((await call({ model: 'no spaces allowed' })).status, 400);

  const quarantined = await call({ model: 'dead-free' }, {}, fakeGh());
  assert.equal(quarantined.status, 409);
  const qb = await quarantined.json();
  assert.equal(qb.verdict, 'skip');
  assert.ok(qb.retry_after > 0, 'the caller is told when to come back');

  // a repo whose budget is spent must not be dispatched at all
  d1._budget.set('o/one|dead2-free', { scope: 'o/one', model: 'dead2-free', minute_count: 50, minute_at: NOW, day_count: 0, day: '2026-10-04' });
  const spent = await call({ model: 'dead2-free' });
  assert.equal(spent.status, 429);
  assert.equal((await spent.json()).reason, 'minute');

  const ghFail = await call({ model: 'ok-free' }, {}, fakeGh({ status: 422 }));
  assert.equal(ghFail.status, 502);
  assert.equal((await ghFail.json()).gh_status, 422, 'GitHub status is passed through, not swallowed');
  assert.equal((await call({ model: 'ok-free' }, {}, fakeGh({ throws: true }))).status, 502);

  const noRepo = await handle(new Request('https://l.test/zen/run', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x-free' }),
  }), env(fakeD1()), { fetchImpl: fakeGh() });
  assert.equal(noRepo.status, 503, 'empty registry = explicit config error');
});

test('POST /zen/report + GET /zen/models: the dead model goes quiet, the healthy one does not', async () => {
  const d1 = fakeD1({ repos: [{ repo: 'o/one', token_ref: 'env:GH_ONE', enabled: 1 }] });
  const report = (body) => handle(new Request('https://l.test/zen/report', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1));

  for (let i = 0; i < 3; i++) await report({ model: 'jev-free', ok: false, kind: 'error', error: '500 Internal server error' });
  await report({ model: 'fledge-free', ok: false, kind: 'provider', error: '429' });
  await report({ model: 'good-free', ok: true });

  const r = await get('/zen/models', d1);
  assert.equal(r.status, 200);
  const b = await r.json();
  const by = Object.fromEntries(b.models.map((m) => [m.model, m]));
  assert.equal(by['jev-free'].status, 'down');
  assert.equal(by['jev-free'].verdict, 'skip');
  assert.ok(by['jev-free'].next_check_in >= LADDERS.down[0] - 1000, 'silent for hours, not seconds');
  assert.equal(by['fledge-free'].verdict, 'skip');
  assert.ok(by['fledge-free'].next_check_in <= LADDERS.flaky[0], 'the ~9%-alive model is re-checked within a minute');
  assert.equal(by['good-free'].status, 'ok');
  assert.equal(by['good-free'].next_check_in, 6 * 3_600_000);
  assert.deepEqual(b.limits, { per_min: 50, per_day: 500 });

  // and the dead model really is refused at the door
  const refused = await handle(new Request('https://l.test/zen/run', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'jev-free' }),
  }), env(d1, { GH_ONE: 'tok-1' }), { fetchImpl: fakeGh() });
  assert.equal(refused.status, 409, 'the 100-times-per-run hammering is exactly what this prevents');
});

test('POST /zen/repos: admin token only, token stored encrypted, never returned; env: reference needs no key', async () => {
  const d1 = fakeD1();
  const call = (body, headers = ADMIN, extra = ADMIN_ENV) => handle(new Request('https://l.test/zen/repos', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1, extra));

  // A ring member holds ZEN_RUNNER_TOKEN. It may run models; it may not rewrite the ring.
  assert.equal((await call({ repo: 'o/one', token: 't' }, auth, ADMIN_ENV)).status, 401,
    'the low-privilege ring token must not open registry writes');
  assert.equal((await call({ repo: 'o/one', token: 't' }, ADMIN, {})).status, 503,
    'no admin token published → refuse loudly instead of accepting the write');

  assert.equal((await call({ repo: 'not-a-repo' })).status, 400);
  const r = await call({ repo: 'o/one', token: 'ghp_supersecret', location: 'eu' });
  assert.equal(r.status, 200);
  const raw = JSON.stringify(await r.json());
  assert.ok(!raw.includes('ghp_supersecret'), 'the token never comes back out');
  const stored = d1._repos[0];
  assert.ok(!String(stored.token_enc).includes('ghp_'), 'stored ciphertext, not plaintext');
  assert.equal(await decryptToken(stored.token_enc, ENV.ZEN_TOKEN_KEY), 'ghp_supersecret');

  await call({ repo: 'o/two', token_ref: 'env:GITHUB_AI_AGENT_RUNS_POOL' });
  assert.equal(d1._repos[1].token_ref, 'env:GITHUB_AI_AGENT_RUNS_POOL');
  assert.equal(d1._repos[1].token_enc, null, 'an env: row stores no secret at all');

  // no key configured → refuse rather than keep a plaintext token
  const d1b = fakeD1();
  const noKey = await handle(new Request('https://l.test/zen/repos', {
    method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'o/x', token: 't' }),
  }), { ...ENV, ...ADMIN_ENV, ZEN_TOKEN_KEY: '', ZEN_DB: d1b }, {});
  assert.equal(noKey.status, 503);

  await call({ repo: 'o/two', enabled: false });
  assert.equal(d1._repos[1].enabled, 0, 'a row can be switched off without deleting it');
});

test('GET /zen/ring/*: the registry lives in CF D1 and the ring token alone cannot read it', async () => {
  const d1 = fakeD1({
    repos: [
      { repo: 'o/enc', token_enc: await encryptToken('ghp_enc', ENV.ZEN_TOKEN_KEY), enabled: 1, location: 'eu', added_at: 1 },
      { repo: 'o/env', token_ref: 'env:GH_ONE', token_enc: null, enabled: 1, location: '', added_at: 2 },
      { repo: 'o/off', token_ref: 'env:GH_ONE', token_enc: null, enabled: 0, added_at: 3 },
    ],
  });
  const envWithSecret = { ...ADMIN_ENV, GH_ONE: 'ghp_from_worker_secret' };

  const listing = await handle(new Request('https://l.test/zen/ring/repos', { headers: ADMIN }), env(d1, envWithSecret), {});
  assert.equal(listing.status, 200);
  const listed = JSON.stringify(await listing.json());
  for (const leak of ['ghp_enc', 'ghp_from_worker_secret', 'token_enc']) {
    assert.ok(!listed.includes(leak), `the human listing must not carry ${leak}`);
  }
  assert.deepEqual(JSON.parse(listed).repos.map((r) => r.repo), ['o/enc', 'o/env', 'o/off']);

  // the payload is what provisioning reads: tokens in, no printing, no caching
  const payload = await handle(new Request('https://l.test/zen/ring/payload', { headers: ADMIN }), env(d1, envWithSecret), {});
  assert.equal(payload.status, 200);
  assert.equal(payload.headers.get('cache-control'), 'no-store', 'plaintext PATs must never sit in a cache');
  const body = await payload.json();
  const byRepo = Object.fromEntries(body.repos.map((r) => [r.repo, r]));
  assert.equal(byRepo['o/enc'].token, 'ghp_enc', 'the encrypted row comes back decrypted for provisioning');
  assert.equal(byRepo['o/env'].token_ref, 'env:GH_ONE', 'the reference is preserved so it stays rotatable');
  assert.equal(byRepo['o/env'].resolved_token, 'ghp_from_worker_secret', 'and resolved for provisioning only');
  assert.equal(byRepo['o/env'].token, undefined, 'an env: row must not be rewritten into a stored copy');
  assert.equal(byRepo['o/off'].enabled, false, 'a switched-off row is still reported, not hidden');

  for (const headers of [auth, {}]) {
    const res = await handle(new Request('https://l.test/zen/ring/payload', { headers }), env(d1, envWithSecret), {});
    assert.equal(res.status, 401, 'only the ring-admin token reads plaintext tokens');
  }
  const noAdmin = { ...envWithSecret, ZEN_RING_ADMIN_TOKEN: '' };
  assert.equal((await handle(new Request('https://l.test/zen/ring/payload', { headers: ADMIN }), env(d1, noAdmin), {})).status, 503,
    'a worker without the admin secret keeps the route closed');
  assert.equal((await handle(new Request('https://l.test/zen/ring/repos', { headers: ADMIN }), env(d1, noAdmin), {})).status, 503);
});

test('budget caps are configurable per environment, defaults are the owner numbers', async () => {
  const d1 = fakeD1({ repos: [{ repo: 'o/one', token_ref: 'env:GH_ONE', enabled: 1 }] });
  d1._budget.set('o/one|m-free', { scope: 'o/one', model: 'm-free', minute_count: 9, minute_at: NOW, day_count: 0, day: '2026-10-04' });
  const call = (extra) => handle(new Request('https://l.test/zen/run', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm-free' }),
  }), env(d1, { GH_ONE: 't', ...extra }), { fetchImpl: fakeGh() });
  assert.equal((await call({ ZEN_PER_MIN: '10' })).status, 202, '9 of 10 — still allowed');
  assert.equal((await call({ ZEN_PER_MIN: '9' })).status, 429, 'the cap is a variable, not a constant');
});

test('GET /zen/result/{run_id}: the answer text is readable without the run log', async () => {
  const d1 = fakeD1();
  // The row exists first: POST /zen/run created it, the runner reported back against it. A report
  // for an unknown run_id updates zero rows — exactly like the real D1.
  d1._runs.set('run-1', { id: 'run-1', model: 'm-free', repo: 'acme/pool', location: 'eu', status: 'dispatched', created_at: NOW });
  const report = (body) => handle(new Request('https://l.test/zen/report', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1));

  await report({ run_id: 'run-1', model: 'm-free', ok: true, answer: 'Paris is the capital of France.' });
  const r = await get('/zen/result/run-1', d1);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.answer, 'Paris is the capital of France.');
  assert.equal(b.model, 'm-free');
  assert.equal(b.status, 'reported');

  const missing = await get('/zen/result/nope', d1);
  assert.equal(missing.status, 404);
});