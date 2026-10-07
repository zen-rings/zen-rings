#!/usr/bin/env node
// Zen free client — call the anonymous zen free tier (https://opencode.ai/zen/v1) from a script
// or a GitHub Actions job WITHOUT tripping its invisible quota blind, and be able to say after
// the fact whether a call was refused by the MODEL or by the LIMIT.
//
// Spec: docs/github-actions-zen-client-spec.md · scenario:
// docs/user-scenarios/zen/zen-free-client-from-gha.md · limits measured in issue #106
// (docs/free-tier-limits.md).
//
// Why this exists next to scripts/zen-limit-probe.mjs: the probe is built to BREAK limits on
// purpose (that is how #106 measured them) — unguarded, no state, no classification. This client
// is the opposite: it stays below the limits and reports which limit stopped it, so a job can
// tell "the model is bad" from "we ran out of quota for this hour". Limits are per (egress IP,
// MODEL), so every counter, rate window and cooldown here is keyed by model, never global.
//
// Three things zen checks, all measured live:
//   * user-agent must start with `opencode/` (the version is NOT pinned — opencode/9.99.99 works)
//   * x-opencode-session must look like ses_<12 hex><14 alnum> (the VALUE is free and reusable)
//   * the body must carry stream:true and tools containing both `shell` and `read`
// Missing any of the three → 403 FreeTierError, which is OUR bug, not a limit, and must be loud.
//
// Usage:
//   import { createZenClient } from './zen-client.mjs';
//   const zen = createZenClient({ ratePerMin: 80, dailyBudget: 800 });
//   const r = await zen.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'ping' }] });
//   if (!r.ok) { if (r.kind === 'cooldown') break; throw new Error(r.kind); }
//   console.log(zen.summary());
//
// No dependencies (repo rule): node:crypto + fetch only. No secrets: the free tier is anonymous.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const ZEN_BASE = 'https://opencode.ai/zen/v1';
const UA = 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';

export const SHELL_TOOL = { type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } };
export const READ_TOOL = { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };

// Context caps, measured live with `zen-limit-probe.mjs --fill-tokens` (spec §4). zen
// /v1/models does NOT expose context_length at all, so this table is the only source and a stale
// entry is worse than a missing one. UNMEASURED models are deliberately absent: an absent model
// reports `{unknown: true}` and lets the server decide, whereas a guessed cap would silently
// refuse work that would have fit.
//
// `big-pickle` is the floor, NOT the maximum: it balances across backends with 262 139 and >=1M
// caps and which one you get is not deterministic. Promising the maximum would be false
// reliability — see spec §4 and the scenario's open points.
// Measured free models missing here as of 2026-10-04 (run --fill-tokens before adding any):
// deepseek-v4-flash-free, nemotron-3-ultra-free, ling-3.1-flash-free, space-bunny-free,
// longcat-2.5-preview-free, jev-1.13-free, fledge-alpha-free, muse-spark-1.3/1.2-contributor-free.
export const CONTEXT = {
  'mimo-v2.6-flash-free': 1048576,
  'mimo-v2.5-free': 1048576,
  'nemotron-3.5-lightning-free': 1000000,
  'big-pickle': 262139,
};

const randHex = n => crypto.randomBytes(n).toString('hex');
const randAlnum = n => {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += c[b[i] % c.length];
  return s;
};

export function zenHeaders({ session, request } = {}) {
  return {
    'content-type': 'application/json',
    'authorization': 'Bearer public',
    'user-agent': UA,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-request': request || `msg_${randHex(6)}${randAlnum(12)}`,
    'x-opencode-session': session || `ses_${randHex(6)}${randAlnum(14)}`,
  };
}

// Token estimate without a tokenizer dependency: ~3.5 chars/token (English ~4, Cyrillic ~2.5).
// Deliberately pessimistic — over-estimating is the safe direction for a pre-flight cap check.
export const estTokens = s => Math.ceil(String(s ?? '').length / 3.5);
const MSG_OVERHEAD = 4;

function messagesInputTokens(messages) {
  return (messages || []).reduce((n, m) => n + estTokens(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')) + MSG_OVERHEAD, 0);
}

// The cap covers the WHOLE request: input + max_tokens must fit, or the server answers
// 400 "Input token count (N) exceeds ... no tokens left for generation". A model that is not in
// the table is passed through (`unknown`) instead of being guessed at.
export function contextCheck(model, messages, maxTokens, table = CONTEXT) {
  const cap = table[model];
  if (!cap) return { ok: true, unknown: true };
  const input = messagesInputTokens(messages);
  const need = input + maxTokens;
  return need <= cap
    ? { ok: true, unknown: false, input, cap, maxTokens }
    : { ok: false, input, cap, maxTokens, over: need - cap };
}

// Drop the oldest non-system messages until the request fits. A job that hits this MUST report
// it: a silently shortened prompt is a silently different answer.
function fitByTruncation(model, messages, maxTokens, table) {
  const kept = messages.slice();
  let dropped = 0;
  for (;;) {
    const check = contextCheck(model, kept, maxTokens, table);
    if (check.ok) return { messages: kept, dropped, check };
    const i = kept.findIndex(m => m.role !== 'system');
    if (i < 0) return { messages: kept, dropped, check };
    kept.splice(i, 1);
    dropped++;
  }
}

// CLI flags for the probe scripts. A flag whose value is MISSING must fall back to its default
// instead of eating the next flag: a scheduled workflow run passes no inputs at all, so the shell
// builds `--runs --prompt x`, and a parser that grabs the next token turns that into
// Number("--prompt") = NaN. The loop `for (i = 0; i < NaN; i++)` then never runs and the whole
// self-test reports green having made ZERO live calls — a false green, the worst kind.
// Returns { values, problems }; problems are caller-fatal, never silently defaulted.
export function parseArgs(argv, defaults = {}, { numeric = [] } = {}) {
  const values = { ...defaults };
  const problems = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const name = tok.slice(2);
    const next = argv[i + 1];
    const isFlag = typeof next === 'string' && next.startsWith('--') && next.length > 2;
    if (next === undefined || isFlag) {
      if (typeof defaults[name] === 'boolean') { values[name] = true; continue; }
      problems.push(`--${name} has no value`);
      continue;
    }
    i++;
    if (numeric.includes(name)) {
      const n = Number(next);
      if (!Number.isInteger(n) || n < 1) { problems.push(`--${name} must be an integer >= 1, got "${next}"`); continue; }
      values[name] = n;
    } else {
      values[name] = next;
    }
  }
  return { values, problems };
}

export function classify(status, headers, bodyText) {
  if (status === 403) return { kind: 'fingerprint' };
  if (status === 429) {
    const raw = headers?.get ? headers.get('retry-after') : null;
    const retryAfterSec = raw == null ? null : Number(raw);
    if (raw != null && Number.isFinite(retryAfterSec) && retryAfterSec > 0) return { kind: 'daily', retryAfterSec };
    const provider = /from provider \(Console\)/i.test(String(bodyText || ''));
    return { kind: provider ? 'provider' : 'rate' };
  }
  if (status >= 500) return { kind: 'error', retryable: true };
  return { kind: 'error', retryable: false };
}

// SSE → one chat.completion. The same fold the relay uses (aggregateSse there) — kept as a
// copy on purpose so this module stays self-contained and can be vendored into a job's own repo
// without dragging the relay in. If you change one, change the other.
export function aggregateSse(text) {
  let content = '';
  let finish = null;
  let usage = null;
  let id = null;
  let model = null;
  let created = null;
  const toolCalls = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let d;
    try { d = JSON.parse(payload); } catch { continue; }
    if (d.error) continue;
    if (d.id) id = d.id;
    if (d.model) model = d.model;
    if (d.created) created = d.created;
    if (d.usage) usage = d.usage;
    const choice = d.choices && d.choices[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index || 0;
        toolCalls[i] = toolCalls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function && tc.function.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const message = { role: 'assistant', content };
  const tools = toolCalls.filter(Boolean);
  if (tools.length) message.tool_calls = tools;
  return {
    id: id || `zen-client-${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{ index: 0, message, finish_reason: finish || (tools.length ? 'tool_calls' : 'stop') }],
    ...(usage ? { usage } : {}),
  };
}

// Sliding 60 s window. The measured provider rate limit is ~90-95 req/min per (IP, model), so
// 80 keeps ~15% headroom. One window PER MODEL: collapsing models into one window would throttle
// a healthy model because a different provider tripped.
export class RateWindow {
  constructor(perMin, windowMs = 60_000) {
    this.perMin = perMin;
    this.windowMs = windowMs;
    this.ts = [];
  }
  free(now) {
    this.ts = this.ts.filter(t => now - t < this.windowMs);
    return this.perMin - this.ts.length;
  }
  msUntilSlot(now) {
    if (this.free(now) > 0) return 0;
    return Math.max(0, this.windowMs - (now - this.ts[0]) + 50);
  }
  take(now) {
    this.ts = this.ts.filter(t => now - t < this.windowMs);
    this.ts.push(now);
  }
  async wait(sleep, now = Date.now()) {
    let elapsed = 0;
    for (;;) {
      const t = now + elapsed;
      this.ts = this.ts.filter(x => t - x < this.windowMs);
      if (this.ts.length < this.perMin) { this.ts.push(t); return { waitedMs: elapsed, at: t }; }
      const pause = Math.max(0, this.windowMs - (t - this.ts[0]) + 50);
      await sleep(pause);
      elapsed += pause;
    }
  }
}

export class Governors {
  constructor(perMin, windowMs) {
    this.perMin = perMin;
    this.windowMs = windowMs;
    this.byModel = new Map();
  }
  window(model) {
    if (!this.byModel.has(model)) this.byModel.set(model, new RateWindow(this.perMin, this.windowMs));
    return this.byModel.get(model);
  }
  peak(model) { return this.window(model).ts.length; }
}

const utcDay = d => new Date(d).toISOString().slice(0, 10);
const nextUtcMidnight = now => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);

// Fixed-egress persistence (spec §7 mode B). Counters and cooldowns live per model because the
// quota is per model; the UTC day is the reset boundary. Only calls/cooldownUntil are restored —
// the rest of a report belongs to the run that produced it.
export function loadState(file, now = Date.now()) {
  const today = utcDay(now);
  const fresh = () => ({ day: today, models: {} });
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.day !== today) return fresh();
    const models = {};
    for (const [m, v] of Object.entries(parsed.models || {})) {
      models[m] = { calls: Number(v?.calls) || 0, cooldownUntil: Number(v?.cooldownUntil) || 0 };
    }
    return { day: today, models };
  } catch {
    return fresh();
  }
}

export function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

export function createZenClient({
  base = ZEN_BASE,
  ratePerMin = 80,
  dailyBudget = 800,
  providerCooldownMs = 60 * 60 * 1000,
  context = CONTEXT,
  truncate = false,
  state = null,
  session = null,
  timeoutMs = 90_000,
  rateWaitMaxMs = 0,
  fetchImpl,
  sleep,
  now: clock = () => Date.now(),
} = {}) {
  const doFetch = fetchImpl || fetch;
  const doSleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const governors = new Governors(ratePerMin);
  const models = new Map();
  const day = state?.day || utcDay(clock());

  const slot = model => {
    if (!models.has(model)) {
      const carried = state?.models?.[model] || {};
      models.set(model, {
        calls: Number(carried.calls) || 0,
        ok: 0,
        limited: 0,
        errors: 0,
        contextSkips: 0,
        cooldownUntil: Number(carried.cooldownUntil) || 0,
        lastKind: null,
        lastRetryAfterSec: null,
        stoppedBy: null,
      });
    }
    return models.get(model);
  };

  const client = {
    contextCap(model) { return context[model] ?? null; },

    // Peak occupancy of this model's sliding window since it was created — the §12.2 evidence
    // that the governor actually held the line (must never exceed ratePerMin).
    ratePeak(model) { return governors.peak(model); },

    state() {
      const out = { day, models: {} };
      for (const [m, v] of models) out.models[m] = { ...v };
      for (const [m, v] of Object.entries(state?.models || {})) {
        if (!out.models[m]) out.models[m] = { calls: v.calls || 0, ok: 0, limited: 0, errors: 0, contextSkips: 0, cooldownUntil: v.cooldownUntil || 0, lastKind: null, lastRetryAfterSec: null, stoppedBy: null };
      }
      return out;
    },

    summary() {
      const byModel = {};
      for (const [m, v] of Object.entries(this.state().models)) {
        byModel[m] = { calls: v.calls, ok: v.ok, limited: v.limited, stoppedBy: v.stoppedBy, cooldownUntil: v.cooldownUntil || null };
      }
      return { byModel };
    },

    async chat({ model, messages, tools = [], maxTokens = 1500, timeoutMs: callTimeoutMs = timeoutMs } = {}) {
      if (!model) return { ok: false, kind: 'error', retryable: false, error: 'model is required — the limit is per model, so the client cannot guess one' };
      const s = slot(model);
      const t0 = clock();

      if (s.cooldownUntil > t0) {
        return { ok: false, kind: 'cooldown', cooldownUntil: s.cooldownUntil, cooldownUntilIso: new Date(s.cooldownUntil).toISOString(), stoppedBy: s.stoppedBy || 'remote-daily', reason: 'cooldown active — no request sent' };
      }

      if (s.calls >= dailyBudget) {
        s.stoppedBy = s.stoppedBy || 'local-budget';
        const until = nextUtcMidnight(t0);
        s.cooldownUntil = until;
        return { ok: false, kind: 'cooldown', stoppedBy: 'local-budget', cooldownUntil: until, cooldownUntilIso: new Date(until).toISOString(), calls: s.calls, dailyBudget, reason: 'daily budget spent on this model' };
      }

      let payload = messages || [];
      let check = contextCheck(model, payload, maxTokens, context);
      let truncated = 0;
      if (!check.ok && truncate) {
        const fit = fitByTruncation(model, payload, maxTokens, context);
        payload = fit.messages;
        truncated = fit.dropped;
        check = fit.check;
      }
      if (!check.ok) {
        s.contextSkips++;
        s.lastKind = 'context';
        return { ok: false, kind: 'context', cap: check.cap, input: check.input, maxTokens: check.maxTokens, over: check.over, reason: 'prompt + max_tokens exceeds the model cap — nothing was sent, no cooldown set' };
      }
      if (truncated) s.contextSkips++;

      const window = governors.window(model);
      const waitMs = window.msUntilSlot(t0);
      if (rateWaitMaxMs > 0 && waitMs > rateWaitMaxMs) {
        s.stoppedBy = s.stoppedBy || 'local-rate';
        return { ok: false, kind: 'cooldown', stoppedBy: 'local-rate', cooldownUntil: t0 + waitMs, cooldownUntilIso: new Date(t0 + waitMs).toISOString(), waitMs, reason: 'rate window full and rateWaitMaxMs exceeded' };
      }
      if (waitMs > 0) { await doSleep(waitMs); window.take(clock()); }
      else window.take(clock());

      const body = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        messages: payload,
      };
      const merged = new Map();
      for (const t of [SHELL_TOOL, READ_TOOL, ...tools]) {
        const name = t?.function?.name;
        if (name) merged.set(name, t);
      }
      body.tools = [...merged.values()];
      if (!tools.length) body.tool_choice = 'none';

      s.calls++;
      const started = clock();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), callTimeoutMs);
      let res, text = '';
      try {
        res = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: zenHeaders({ session }),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        text = await res.text();
      } catch (e) {
        const aborted = e?.name === 'AbortError';
        s.errors++;
        s.lastKind = aborted ? 'timeout' : 'error';
        return { ok: false, kind: aborted ? 'timeout' : 'error', retryable: true, error: String(e?.message || e).slice(0, 200), ms: clock() - started };
      } finally {
        clearTimeout(timer);
      }

      const ms = clock() - started;
      if (res.status !== 200) {
        const verdict = classify(res.status, res.headers, text);
        s.lastKind = verdict.kind;
        if (verdict.kind === 'daily') {
          s.limited++;
          s.lastRetryAfterSec = verdict.retryAfterSec;
          s.cooldownUntil = started + verdict.retryAfterSec * 1000;
          s.stoppedBy = 'remote-daily';
          return { ok: false, kind: 'daily', status: 429, retryAfterSec: verdict.retryAfterSec, cooldownUntil: s.cooldownUntil, cooldownUntilIso: new Date(s.cooldownUntil).toISOString(), stoppedBy: 'remote-daily', bodySnippet: text.slice(0, 300), ms };
        }
        if (verdict.kind === 'provider' || verdict.kind === 'rate') {
          s.limited++;
          s.cooldownUntil = started + providerCooldownMs;
          s.stoppedBy = 'remote-provider';
          return { ok: false, kind: verdict.kind, status: 429, cooldownUntil: s.cooldownUntil, cooldownUntilIso: new Date(s.cooldownUntil).toISOString(), stoppedBy: 'remote-provider', bodySnippet: text.slice(0, 300), ms };
        }
        s.errors++;
        return { ok: false, kind: verdict.kind, status: res.status, retryable: verdict.retryable, bodySnippet: text.slice(0, 300), ms };
      }

      s.ok++;
      s.lastKind = 'ok';
      s.stoppedBy = null;
      const aggregated = aggregateSse(text);
      return { ok: true, message: aggregated.choices[0].message, usage: aggregated.usage || null, finish_reason: aggregated.choices[0].finish_reason, ms, ...(truncated ? { truncatedMessages: truncated } : {}) };
    },
  };

  return client;
}