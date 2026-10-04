// trained-assist-llm-ladder — OpenAI-compatible chat completions over a model ladder
// (OpenCode Go → paid OpenRouter last) for small service LLM calls across trained-assist repos.
//
//   GET  /health                 liveness + ladder names (no auth)
//   GET  /pool/health            pool receiver liveness, {service:"pool",ok:true} (no auth)
//   POST /pool/trigger           runs-pool dispatch, Bearer POOL_TRIGGER_TOKEN, body ≤ 8 KB (own token)
//   GET  /zen/health             zen-runner liveness: registry size, model count, live caps (no auth)
//   GET  /zen/models             availability table + "call it or skip it" verdict (ZEN_RUNNER_TOKEN)
//   POST /zen/run                {model,runs?} → 202 run_id | 409 quarantine | 429 budget | 502 GitHub
//   POST /zen/report             {run_id?,model,ok,kind?,error?} → the state the ladder reads back
//   POST /zen/repos              registry row (repo + encrypted token or env:NAME), round-robin ring
//   POST /zen/pool/invoke        {model,prompt,wait_ms?} → 200 {text} — one long-lived job as an API
//   POST /zen/pool/register      a GitHub Actions job registers itself and gets a lease
//   GET  /zen/pool/pull?lease=…  long-poll for a task; 200 {bye} = exit cleanly
//   POST /zen/pool/result        the answer (text) + the availability verdict
//   POST /zen/pool/stop          tell a job to exit on its next pull
//   GET  /zen/pool/result/{id}   the answer whenever it lands, even after a 504
//   GET  /zen/pool/health        how many jobs are live right now (no auth)
//   GET  /v1/models              ladders as model ids (auth)
//   GET  /v1/state               model health + key rotation snapshot (auth)
//   POST /v1/state/reset-keys    unpark all Go keys + Go rungs (auth, ops lever)
//   POST /v1/chat/completions    body.model = ladder ("service", legacy alias "deepseek", "service:review") (auth)
//
// Auth: `Authorization: Bearer <LADDER_TOKEN>`. Non-streaming → a normal chat.completion whose
// `model` is the rung that answered (also in `x-ladder-model`). stream:true → SSE relayed from
// the chosen rung (chosen before the first token; no failover after it) — how opencode uses the
// `free` model. Tools pass through as is. Optional body fields: ladder_timeout_ms (per
// rung, non-stream), ladder_ttfb_ms (stream: first-token window), ladder_total_timeout_ms,
// ladder_rung (benchmarks: pin one rung of the ladder, no failover).
//
// This file is the Worker entry: it wires the Durable Object binding and dispatches to the route
// in src/handler.js (kept free of the Workerd runtime so plain `node --test` can exercise it).

import { handle } from './handler.js';
import { zenSweep } from './zen-runner.js';

export { LadderState } from './state-do.js';
export { handle, makeStore } from './handler.js';

export default {
  fetch(request, env) {
    return handle(request, env);
  },
  // Every 15 min: re-check quarantined free models whose backoff expired (wrangler.toml [triggers]).
  // Bounded by ZEN_SWEEP_MAX and by the same 50/500 budget as an ordinary /zen/run.
  scheduled(event, env, ctx) {
    ctx.waitUntil(zenSweep(env));
  },
};