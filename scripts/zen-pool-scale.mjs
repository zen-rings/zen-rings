#!/usr/bin/env node
// zen-pool-scale — the scheduled half of the Zen Pool autoscaler.
//
// Reads GET /zen/pool/metrics (λ, queue, live workers, the verdict) and, when the verdict OR the
// caller's own claim says workers are missing, asks the hub to dispatch zen-pool.yml somewhere in
// the ring. The metrics line is printed on every run so λ over time is visible in the Actions
// history.
//
// Exit codes: 0 = at target (or dispatched), 2 = the dispatch was refused, 3 = not configured.
//
// Usage: ZEN_RUNNER_URL=… ZEN_RUNNER_TOKEN=… node scripts/zen-pool-scale.mjs

// How many workers this run wants live, given the metrics verdict and the caller's own claim.
//
// `demand` and `force` belong to THIS run and never appear in /zen/pool/metrics — it answers from
// λ, the queue and the live workers alone. Deciding `at_target` off that verdict alone is what made
// `-f demand=2` a no-op (measured, issue #14: run 37265914523 printed `toDispatch=0 reason=at_target`
// with live=1 and dispatched nothing). So the claim wins over the verdict, and the baseline is the
// same live+inflight the hub counts, which keeps the two numbers comparable.
export function planFromClaim(metrics = {}, { demand = 0, force = false } = {}) {
  const want = Math.max(Number(demand) || 0, force ? 2 : 0);
  const live = Number(metrics.workers_live) || 0;
  const inflight = Number(metrics.inflight) || 0;
  const busy = live + inflight;
  const verdict = Math.max(0, Number(metrics.toDispatch) || 0);
  const toDispatch = want > 0 ? Math.max(0, want - busy) : verdict;
  return { want, live, inflight, busy, verdict, toDispatch, atTarget: !force && toDispatch <= 0 };
}

async function main() {
  const base = String(process.env.ZEN_RUNNER_URL || '').replace(/\/+$/, '');
  const token = String(process.env.ZEN_RUNNER_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_REPOSITORY || '').trim();
  const ghToken = String(process.env.GITHUB_TOKEN || '').trim();
  if (!base || !token || !repo) {
    console.log('SCALE_CONFIG_MISSING ZEN_RUNNER_URL, ZEN_RUNNER_TOKEN and GITHUB_REPOSITORY are all required');
    process.exit(3);
  }

  const res = await fetch(`${base}/zen/pool/metrics`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.log(`SCALE_METRICS_FAILED ${res.status} ${repo}`);
    process.exit(3);
  }
  const m = await res.json();
  console.log(`SCALE repo=${repo} λ=${m.lambda_per_min}/min (n=${m.lambda_count} over ${Math.round(m.window_ms / 1000)}s) `
    + `queued=${m.queued} live=${m.workers_live} inflight=${m.inflight} desired=${m.desired} `
    + `toDispatch=${m.toDispatch} ceiling=${m.ceiling} reserve=${m.reserve} ttl=${Math.round(m.ttl_ms / 60000)}min reason=${m.reason}`);

  // `force` is the operator escape hatch and the only path that works with an EMPTY registry:
  // the hub can only boot a worker in a repo it holds a token for, while this workflow already has
  // a token for its own repository. So a forced run skips the verdict and simply adds itself.
  const force = String(process.env.SCALE_FORCE || '').toLowerCase() === 'true';
  const plan = planFromClaim(m, { demand: Number(process.env.SCALE_DEMAND || 0) || 0, force });
  if (plan.atTarget) {
    console.log(`SCALE at_target (want=${plan.want} live=${plan.live} inflight=${plan.inflight} metrics_toDispatch=${plan.verdict})`);
    process.exit(0);
  }
  if (force) console.log(`SCALE forced=true (metrics verdict was toDispatch=${plan.verdict}) — dispatching anyway`);
  if (plan.want > 0) console.log(`SCALE want=${plan.want} live+inflight=${plan.busy} toDispatch=${plan.toDispatch} (demand=${plan.want})`);
  const idleExit = Number(process.env.SCALE_IDLE_EXIT_MS || 0) || m.ttl_ms;

  // Where the worker comes from. `pool` (the default) asks the hub to scale: IT picks the next
  // repository from the ring round-robin and dispatches zen-pool.yml there, so the ceiling is a
  // property of the ring and every new job lands in another repository — a different egress IP,
  // i.e. a different slice of the free quota. `local` adds this repository itself: the path that
  // still works while the registry is empty, and the fallback when the hub refuses.
  const via = String(process.env.SCALE_VIA || 'pool').toLowerCase();
  if (via === 'pool') {
    // `want`, not the raw input: the hub re-decides against live+inflight and dispatches one worker
    // per slot, so handing it the already-normalised number keeps its verdict and this log in agreement.
    const r = await fetch(`${base}/zen/pool/scale`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ demand: plan.want }),
      signal: AbortSignal.timeout(30_000),
    });
    const b = await r.json().catch(() => ({}));
    const repos = (b.dispatched || []).map((d) => d.repo);
    console.log(`SCALE via=pool http=${r.status} demand=${plan.want} reason=${b.reason ?? '-'} `
      + `toDispatch=${b.toDispatch ?? '-'} dispatched=${JSON.stringify(repos)} errors=${JSON.stringify(b.errors || [])}`);
    if (!r.ok && !repos.length) process.exit(2);
    process.exit(0);
  }
  if (!ghToken) {
    console.log('SCALE_NO_GITHUB_TOKEN — the workflow needs actions: write to dispatch zen-pool.yml');
    process.exit(3);
  }

  // workflow_dispatch, NOT repository_dispatch: the built-in GITHUB_TOKEN may start a workflow_dispatch
  // (measured — live run 37214710313 got as far as the API and was refused only for the repository
  // event), while repository_dispatch needs a PAT or a GitHub App token. That is exactly the token the
  // registry holds per repo, and it is why the hub-side path can keep using the repository event.
  // One repository can only host one of these per run without cancelling itself, so the local path
  // dispatches exactly ONE worker per plan slot it was asked for — i.e. it cannot honour a claim
  // above 2 and says so instead of pretending it did.
  const rounds = Math.min(plan.toDispatch, 2);
  if (plan.toDispatch > rounds) {
    console.log(`SCALE via=local can only add ${rounds} of the ${plan.toDispatch} requested workers — use via=pool for the rest`);
  }
  for (let i = 0; i < rounds; i++) {
    const d = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/zen-pool.yml/dispatches`, {
      method: 'POST',
      headers: { authorization: `token ${ghToken}`, 'content-type': 'application/json',
        accept: 'application/vnd.github+json', 'user-agent': 'trained-assist-llm-ladder' },
      body: JSON.stringify({ ref: process.env.SCALE_REF || 'main', inputs: {
        idle_exit: String(idleExit),
        max_tasks: '0',
        out: 'zen-pool-last.json',
      } }),
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`SCALE dispatched=${d.status} repo=${repo} idle_exit_ms=${idleExit} slot=${i + 1}/${rounds} toDispatch=${plan.toDispatch} via=workflow_dispatch`);
    if (!d.ok) process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`zen-pool-scale failed: ${e?.message || e}`);
    process.exit(3);
  });
}
