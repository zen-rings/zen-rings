// zen-rings — the ring of GitHub Actions repositories that makes the free zen calls:
// the registry of ring repositories, the lease protocol with the long-lived job, the budget
// counters and the autoscaler. It serves no chat surface of its own — there is no /v1 here on
// purpose; a caller wanting completions talks to a ladder worker, and a ladder worker that wants
// a free answer calls this one (POST /zen/pool/invoke, Bearer ZEN_RUNNER_TOKEN).
//
//   GET  /health                 liveness, {ok:true,service:"zen-ring"} (no auth)
//   GET  /pool/health            runs-pool receiver liveness (no auth)
//   POST /pool/trigger           runs-pool dispatch, Bearer POOL_TRIGGER_TOKEN, body ≤ 8 KB (own token)
//   GET  /zen/health             zen-runner liveness: registry size, model count, live caps (no auth)
//   GET  /zen/models             availability table + "call it or skip it" verdict (ZEN_RUNNER_TOKEN)
//   POST /zen/run                {model,runs?} → 202 run_id | 409 quarantine | 429 budget | 502 GitHub
//   POST /zen/report             {run_id?,model,ok,kind?,error?} → the state the caller reads back
//   POST /zen/repos              registry row (repo + encrypted token or env:NAME), round-robin ring
//                                (ZEN_RING_ADMIN_TOKEN — not the ring member's token)
//   GET  /zen/ring/repos         the ring registry read out, no tokens in it (ZEN_RING_ADMIN_TOKEN)
//   GET  /zen/ring/payload       the provisioning list WITH plaintext tokens, from D1 (ZEN_RING_ADMIN_TOKEN)
//   POST /zen/pool/invoke        {model,prompt,wait_ms?} → 200 {text} — one long-lived job as an API
//   POST /zen/pool/register      a GitHub Actions job registers itself and gets a lease
//   GET  /zen/pool/pull?lease=…  long-poll for a task; 200 {bye} = exit cleanly
//   POST /zen/pool/result        the answer (text) + the availability verdict
//   POST /zen/pool/stop          tell a job to exit on its next pull
//   GET  /zen/pool/result/{id}   the answer whenever it lands, even after a 504
//   GET  /zen/pool/health        how many jobs are live right now (no auth)
//   GET  /zen/pool/metrics       autoscaler inputs + verdict (ZEN_RUNNER_TOKEN)
//   POST /zen/pool/scale         run the autoscaler now (ZEN_RUNNER_TOKEN)
//
// Auth: each route names its own token; there is no single ladder token, because there is no
// ladder here. This file is the Worker entry: it dispatches to src/handler.js, kept free of the
// Workerd runtime so plain `node --test` can exercise it.

import { handle } from './handler.js';
import { zenSweep } from './zen-runner.js';

export { handle } from './handler.js';

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