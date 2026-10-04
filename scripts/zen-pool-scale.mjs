#!/usr/bin/env node
// zen-pool-scale — the scheduled half of the Zen Pool autoscaler.
//
// Reads GET /zen/pool/metrics (λ, queue, live workers, the verdict) and, when the verdict says
// workers are missing, dispatches zen-pool.yml in THIS repository: a ring member scaling the pool
// by adding itself. The metrics line is printed on every run so λ over time is visible in the
// Actions history.
//
// Exit codes: 0 = at target (or dispatched), 2 = the dispatch was refused, 3 = not configured.
//
// Usage: ZEN_RUNNER_URL=… ZEN_RUNNER_TOKEN=… node scripts/zen-pool-scale.mjs

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
if (!force && m.toDispatch <= 0) {
  console.log('SCALE at_target');
  process.exit(0);
}
if (force) console.log(`SCALE forced=true (verdict was toDispatch=${m.toDispatch}) — dispatching anyway`);
if (!ghToken) {
  console.log('SCALE_NO_GITHUB_TOKEN — the workflow needs actions: write to dispatch zen-pool.yml');
  process.exit(3);
}

const idleExit = Number(process.env.SCALE_IDLE_EXIT_MS || 0) || m.ttl_ms;

// workflow_dispatch, NOT repository_dispatch: the built-in GITHUB_TOKEN may start a workflow_dispatch
// (measured — live run 37214710313 got as far as the API and was refused only for the repository
// event), while repository_dispatch needs a PAT or a GitHub App token. That is exactly the token the
// registry holds per repo, and it is why the hub-side path can keep using the repository event.
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
console.log(`SCALE dispatched=${d.status} repo=${repo} idle_exit_ms=${idleExit} toDispatch=${m.toDispatch} via=workflow_dispatch`);
if (!d.ok) process.exit(2);
