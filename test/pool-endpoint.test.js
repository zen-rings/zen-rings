import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';

const ENV = { POOL_TRIGGER_TOKEN: 'pool-tok', GITHUB_AI_AGENT_RUNS_POOL: 'ghp_test' };

// Mock of the outgoing dispatch to api.github.com — records url/init, answers with the
// canned status (or throws, like AbortSignal.timeout does on a 10 s stall).
function fakeGh({ status = 204, throws = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throws) { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
    return { ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => '' };
  };
  return { calls, fetchImpl };
}

const post = (body, { token = 'pool-tok', env = ENV, fetchImpl } = {}) =>
  handle(new Request('https://l.test/pool/trigger', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env, { fetchImpl });

test('GET /pool/health — open, no auth, no ladder token involved', async () => {
  const r = await handle(new Request('https://l.test/pool/health'), ENV, {});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { service: 'pool', ok: true });

  // Without any env at all it still answers — liveness like /health.
  const bare = await handle(new Request('https://l.test/pool/health'), {}, {});
  assert.equal(bare.status, 200);
  assert.deepEqual(await bare.json(), { service: 'pool', ok: true });
});

test('no ladder surface: /v1 is gone, not gated — the ring carries no chat routes at all', async () => {
  // Before the ring-only trim /v1/models answered 401 (auth gate). The routes were removed
  // entirely instead of being gated: this worker has no ladder to serve.
  const models = await handle(new Request('https://l.test/v1/models'), ENV, {});
  assert.equal(models.status, 404);
  const chat = await handle(new Request('https://l.test/v1/chat/completions'), ENV, {});
  assert.equal(chat.status, 404);
  // and the ring routes are unaffected
  const h = await handle(new Request('https://l.test/pool/health'), ENV, {});
  assert.equal(h.status, 200);
});

test('POST /pool/trigger: secrets not set → 503 CONFIG, fetch never called', async () => {
  const none = fakeGh();
  const r1 = await post({ task: 'x' }, { env: {}, fetchImpl: none.fetchImpl });
  assert.equal(r1.status, 503);
  assert.equal((await r1.json()).error.type, 'CONFIG');
  assert.equal(none.calls.length, 0);

  const noGh = fakeGh();
  const r2 = await post({ task: 'x' }, { env: { POOL_TRIGGER_TOKEN: 'pool-tok' }, fetchImpl: noGh.fetchImpl });
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).error.type, 'CONFIG');
  assert.equal(noGh.calls.length, 0);
});

test('POST /pool/trigger: missing / wrong bearer → 401, fetch never called', async () => {
  for (const token of [null, 'nope', 'ladder-token', 'pool-tok-']) {
    const gh = fakeGh();
    const r = await post({ task: 'smoke' }, { token, fetchImpl: gh.fetchImpl });
    assert.equal(r.status, 401, `token ${JSON.stringify(token)} must be rejected`);
    assert.equal((await r.json()).error.type, 'auth_error');
    assert.equal(gh.calls.length, 0, 'no dispatch before auth');
  }
});

test('POST /pool/trigger: validation — bad json / task rules / field types → 400, body → 413', async () => {
  const cases = [
    ['not json', 400],
    ['[]', 400],
    ['{"repo":"a/b"}', 400],
    ['{"task":""}', 400],
    ['{"task":"   "}', 400],
    ['{"task":42}', 400],
    ['{"task":"' + 'x'.repeat(4001) + '"}', 400],
    ['{"task":"ok","repo":42}', 400],
    ['{"task":"ok","profile":{}}', 400],
    ['{"task":"ok","artifactRef":["x"]}', 400],
    ['{"task":"ok","junk":"' + 'a'.repeat(9000) + '"}', 413],
  ];
  for (const [raw, expected] of cases) {
    const gh = fakeGh();
    const r = await post(raw, { fetchImpl: gh.fetchImpl });
    assert.equal(r.status, expected, `body ${raw.slice(0, 40)}… → ${expected}`);
    assert.equal(gh.calls.length, 0, 'validation happens before any dispatch');
  }
});

test('POST /pool/trigger: 204 from GitHub → 202 {queued:true}, dispatch carries the metadata', async () => {
  const gh = fakeGh();
  const r = await post({ task: 'smoke', repo: 'o/n', profile: 'p', artifactRef: 'https://obj/x?X-Amz-Signature=t' }, { fetchImpl: gh.fetchImpl });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { queued: true, location: '' });

  assert.equal(gh.calls.length, 1);
  const { url, init } = gh.calls[0];
  assert.equal(url, 'https://api.github.com/repos/vovalikessmoothy-png/ai-agent-runs-pool/dispatches');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'token ghp_test');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.ok(init.signal instanceof AbortSignal, '10 s timeout signal attached');

  const sent = JSON.parse(init.body);
  assert.equal(sent.event_type, 'agent-task');
  assert.equal(sent.client_payload.task, 'smoke');
  assert.equal(sent.client_payload.repo, 'o/n');
  assert.equal(sent.client_payload.profile, 'p');
  assert.equal(sent.client_payload.artifactRef, 'https://obj/x?X-Amz-Signature=t', 'reference relayed as-is, never fetched');
  assert.equal(sent.client_payload.location, '', 'location normalized to "" when absent (D4)');
  assert.ok(!Number.isNaN(Date.parse(sent.client_payload.ts)), 'ts is a timestamp');
});

test('POST /pool/trigger: absent optionals are dropped from the payload; 4000-char task accepted', async () => {
  const gh = fakeGh();
  const r = await post({ task: 'x'.repeat(4000) }, { fetchImpl: gh.fetchImpl });
  assert.equal(r.status, 202);
  const { client_payload: cp } = JSON.parse(gh.calls[0].init.body);
  assert.equal(cp.task.length, 4000);
  assert.ok(!('repo' in cp) && !('profile' in cp) && !('artifactRef' in cp));
  assert.equal(cp.location, '', 'location is always present in the dispatch, normalized');
});

test('POST /pool/trigger: non-2xx → 502 dispatch_failed + gh_status; timeout → 502 + null', async () => {
  const gh422 = fakeGh({ status: 422 });
  const r1 = await post({ task: 'smoke' }, { fetchImpl: gh422.fetchImpl });
  assert.equal(r1.status, 502);
  assert.deepEqual(await r1.json(), { error: 'dispatch_failed', gh_status: 422 });

  const gh500 = fakeGh({ status: 500 });
  const r2 = await post({ task: 'smoke' }, { fetchImpl: gh500.fetchImpl });
  assert.equal(r2.status, 502);
  assert.equal((await r2.json()).gh_status, 500);

  const ghTimeout = fakeGh({ throws: true });
  const r3 = await post({ task: 'smoke' }, { fetchImpl: ghTimeout.fetchImpl });
  assert.equal(r3.status, 502);
  assert.deepEqual(await r3.json(), { error: 'dispatch_failed', gh_status: null });
});

test('POST /pool/trigger: log line carries metadata only — never the task text or tokens', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (line) => { lines.push(String(line)); };
  try {
    const gh = fakeGh();
    const r = await post({ task: 'TOP-SECRET-TASK' }, { fetchImpl: gh.fetchImpl });
    assert.equal(r.status, 202);
    const fail = fakeGh({ status: 500 });
    assert.equal((await post({ task: 'TOP-SECRET-TASK' }, { fetchImpl: fail.fetchImpl })).status, 502);
  } finally {
    console.log = orig;
  }
  const all = lines.join('\n');
  assert.ok(!all.includes('TOP-SECRET-TASK'), 'task text must never reach the log');
  assert.ok(!all.includes('pool-tok') && !all.includes('ghp_test'), 'tokens must never reach the log');
  const ok = lines.map(l => JSON.parse(l)).find(l => l.route === 'pool/trigger' && l.ok === true);
  assert.equal(ok.task_len, 15, 'metadata: task length logged');
  assert.equal(ok.gh_status, 204);
});

// ── location contract (epic ai-agent-run-api#1, Ф1 / блок D) ────────────────────────────────
test('POST /pool/trigger: location enum — ru/eu/us accepted and marked reserved, "" and absent are our pool', async () => {
  for (const location of ['', 'ru', 'eu', 'us']) {
    const gh = fakeGh();
    const r = await post({ task: 'smoke', location }, { fetchImpl: gh.fetchImpl });
    assert.equal(r.status, 202, `location=${JSON.stringify(location)} must be accepted`);
    const body = await r.json();
    assert.equal(body.queued, true);
    assert.equal(body.location, location);
    if (location === '') assert.ok(!('reserved' in body), 'empty location is not reserved');
    else assert.equal(body.reserved, true, `${location} must be reserved`);

    const cp = JSON.parse(gh.calls[0].init.body).client_payload;
    assert.equal(cp.location, location, 'location relayed in the dispatch payload');
  }
});

test('POST /pool/trigger: location absent == empty (D4)', async () => {
  const gh = fakeGh();
  const withField = await post({ task: 'smoke', location: '' }, { fetchImpl: gh.fetchImpl });
  const withoutField = await post({ task: 'smoke' }, { fetchImpl: gh.fetchImpl });
  assert.equal(withField.status, 202);
  assert.equal(withoutField.status, 202);
  assert.deepEqual(await withField.json(), await withoutField.json(), 'D4: missing field and "" must answer identically');
  const cpA = JSON.parse(gh.calls[0].init.body).client_payload;
  const cpB = JSON.parse(gh.calls[1].init.body).client_payload;
  assert.equal(cpA.location, cpB.location, 'dispatch payloads equal too');
});

test('POST /pool/trigger: invalid location → 400 naming the field, no dispatch (D3)', async () => {
  for (const bad of ['xxx', 'RU', 'ru,eu', '1', 'asia', 'us west', 'ru ', null, 42, ['ru'], {}]) {
    const gh = fakeGh();
    const r = await post({ task: 'smoke', location: bad }, { fetchImpl: gh.fetchImpl });
    assert.equal(r.status, 400, `location=${JSON.stringify(bad)} must be 400`);
    const text = JSON.stringify(await r.json());
    assert.match(text, /location/i, `error must name the field (got ${text})`);
    assert.equal(gh.calls.length, 0, 'validation happens before any dispatch');
  }
});

test('POST /pool/trigger: log carries location metadata — still never the task text', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (line) => { lines.push(String(line)); };
  try {
    const gh = fakeGh();
    assert.equal((await post({ task: 'TOP-SECRET-TASK', location: 'ru' }, { fetchImpl: gh.fetchImpl })).status, 202);
  } finally {
    console.log = orig;
  }
  const all = lines.join('\n');
  assert.ok(!all.includes('TOP-SECRET-TASK'), 'task text must never reach the log');
  const ok = lines.map((l) => JSON.parse(l)).find((l) => l.route === 'pool/trigger' && l.ok === true);
  assert.equal(ok.location, 'ru', 'location is metadata and is logged');
});
