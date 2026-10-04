#!/usr/bin/env node
// zen-pool-call — the caller side of Zen Pool: one POST, one answer.
//
// This is what "запуск через API" looks like from the outside: no GitHub dispatch, no run log to
// scrape, no knowledge of which job served it. `wait_ms` is how long WE are willing to wait —
// the caller's watchdog, not the pool's.
//
//   node scripts/zen-pool-call.mjs --model <id> [--prompt <text>] [--wait-ms 30000] [--follow 60]
//
// Exit codes: 0 = the answer came back as text; 3 = the pool refused or is empty; 4 = the
// watchdog fired and the answer never arrived.

const T0 = Date.now();
const base = (process.env.ZEN_RUNNER_URL || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
const token = String(process.env.ZEN_RUNNER_TOKEN || '').trim();

function parse(argv) {
  const out = { prompt: 'Answer in one short sentence: what is 2+4?', waitMs: 30_000, follow: 0, maxTokens: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--max-tokens') out.maxTokens = Number(argv[++i]) || out.maxTokens;
    else if (a === '--wait-ms') out.waitMs = Number(argv[++i]) || out.waitMs;
    else if (a === '--follow') out.follow = Number(argv[++i]) || 0;
  }
  return out;
}

const args = parse(process.argv.slice(2));
if (!args.model || !token) {
  console.log('CALL_CONFIG_MISSING --model and ZEN_RUNNER_TOKEN are required');
  process.exit(3);
}

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function getResult(id) {
  const res = await fetch(`${base}/zen/pool/result/${encodeURIComponent(id)}`, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const health = await fetch(`${base}/zen/pool/health`).then((r) => r.json()).catch(() => null);
console.log('CALL_POOL ' + JSON.stringify({ workers_live: health?.workers_live ?? null, queued: health?.queued ?? null, workers: health?.workers ?? null }));

const sent = Date.now();
const res = await fetch(`${base}/zen/pool/invoke`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ model: args.model, prompt: args.prompt, max_tokens: args.maxTokens, wait_ms: args.waitMs }),
});
const body = await res.json().catch(() => ({}));
const elapsed = Date.now() - sent;
console.log('CALL_STATUS ' + JSON.stringify({ http: res.status, elapsed_ms: elapsed, wait_ms: body.wait_ms ?? args.waitMs, task_id: body.task_id ?? null }));

if (res.status === 200 && body.text) {
  console.log('CALL_TEXT ' + body.text);
  console.log('CALL_RESULT ' + JSON.stringify({ ok: true, model: body.model, chars: body.text.length, served_ms: body.served_ms, provider_ms: body.provider_ms, worker_id: body.worker_id, round_trip_ms: elapsed }));
  process.exit(0);
}

if (res.status === 504 && args.follow > 0) {
  console.log('CALL_WATCHDOG_FIRED — the job is still working; asking for the answer anyway');
  const deadline = Date.now() + args.follow * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const late = await getResult(body.task_id);
    if (late.json?.state === 'done') {
      console.log('CALL_TEXT ' + late.json.text);
      console.log('CALL_RESULT ' + JSON.stringify({ ok: true, late: true, model: late.json.model, chars: (late.json.text || '').length, served_ms: late.json.served_ms, provider_ms: late.json.provider_ms, worker_id: late.json.worker_id, waited_total_ms: Date.now() - sent }));
      process.exit(0);
    }
    console.log('CALL_PENDING ' + JSON.stringify({ state: late.json?.state ?? null, elapsed_ms: Date.now() - sent }));
  }
  console.log('CALL_RESULT ' + JSON.stringify({ ok: false, reason: 'watchdog_expired_no_answer', task_id: body.task_id, waited_total_ms: Date.now() - sent }));
  process.exit(4);
}

console.log('CALL_RESULT ' + JSON.stringify({ ok: false, http: res.status, error: body.error ?? null, kind: body.kind ?? null, detail: body.hint ?? null, elapsed_ms: elapsed }));
process.exit(3);