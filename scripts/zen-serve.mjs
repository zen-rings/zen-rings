#!/usr/bin/env node
// zen-serve — one model, one prompt, one answer, with the boot clock attached.
//
// The self-test (zen-selftest.mjs) answers "is this model alive today". This one answers a
// different question: "run THIS prompt on THIS model and give me the text back" — the smallest
// possible launcher, so a caller (the ladder's /zen/run, or an operator with a token) can turn a
// GitHub Actions run into a single inference call and read the answer out of the run log.
//
// Why the timings are the point: a dispatched run is not alive the moment GitHub accepts it. The
// run still has to be scheduled onto a runner, check out, get a Node, and only then touch zen.
// Every stage is stamped with an absolute UTC ISO time so the caller can subtract its own
// dispatch time and learn the real cold start instead of guessing one.
//
// Usage:
//   node scripts/zen-serve.mjs --model <id> [--prompt <text>] [--max-tokens N] [--out file.json]
//
// Output: a one-line `SERVE_RESULT {json}` on stdout (greppable from `gh run view --log`),
// the full record in --out, and a `BOOT <stage> <iso8601>` line per stage. Exit code 0 only when
// the provider actually answered; any refusal exits 2 so a green job can never mean "nothing ran".

import { writeFileSync } from 'node:fs';
import { createZenClient } from './zen-client.mjs';

const T0 = Date.now();
const iso = () => new Date().toISOString();
const marks = [];
const mark = (stage, extra = {}) => {
  const at = Date.now();
  marks.push({ stage, at, iso: iso(), ms_since_start: at - T0, ...extra });
  console.log(`BOOT ${stage} ${iso()} +${at - T0}ms${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`);
  return at;
};

function parse(argv) {
  const out = { prompt: 'Answer in one short sentence: what is 2+4?', maxTokens: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--max-tokens') out.maxTokens = Number(argv[++i]) || out.maxTokens;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--model-file') out.model = (argv[++i] || '').trim();
  }
  return out;
}

const args = parse(process.argv.slice(2));
mark('process_start', { node: process.version, model: args.model || null });

if (!args.model) {
  console.log('SERVE_RESULT ' + JSON.stringify({ ok: false, kind: 'config', error: '--model is required — the caller names the model, this script never picks one' }));
  process.exit(2);
}

const client = createZenClient({
  ratePerMin: 50,
  dailyBudget: Number(process.env.ZEN_DAILY_BUDGET || 500),
  rateWaitMaxMs: 0,
  timeoutMs: Number(process.env.ZEN_TIMEOUT_MS || 90_000),
});
mark('client_ready');

const messages = [{ role: 'user', content: args.prompt }];
const t = mark('request_sent', { model: args.model, prompt_chars: args.prompt.length });
const res = await client.chat({ model: args.model, messages, maxTokens: args.maxTokens });
mark('response_received', { ok: !!res.ok, ms: res.ms ?? null, kind: res.kind || 'ok' });

const text = res.ok
  ? String(res.message?.content ?? '').trim()
  : '';
const record = {
  ok: !!res.ok && text.length > 0,
  model: args.model,
  prompt: args.prompt,
  text,
  finish_reason: res.finish_reason ?? null,
  usage: res.usage ?? null,
  provider_ms: res.ms ?? null,
  kind: res.ok ? 'ok' : res.kind,
  status: res.status ?? null,
  error: res.ok ? null : String(res.error || res.bodySnippet || '').slice(0, 500),
  runner: {
    run_id: process.env.ZEN_RUN_ID || null,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB || null,
    runner_name: process.env.RUNNER_NAME || null,
    runner_os: process.env.RUNNER_OS || null,
    image: process.env.ImageOS || process.env.ImageVersion || null,
    egress_ip: process.env.ZEN_EGRESS_IP || null,
  },
  marks,
  served_at: iso(),
};

if (args.out) writeFileSync(args.out, JSON.stringify(record, null, 2));
console.log('SERVE_RESULT ' + JSON.stringify({
  ok: record.ok, model: record.model, kind: record.kind, status: record.status,
  provider_ms: record.provider_ms, chars: text.length, text: text.slice(0, 800),
  error: record.error, boot_ms: Date.now() - T0,
}));
if (!record.ok) {
  console.log('NOTHING WAS VERIFIED — the provider did not return text for this model');
  process.exit(2);
}
process.exit(0);
