#!/usr/bin/env node
// Sweep this repository's own finished Actions runs at the end of a pool worker run.
//
// Why this exists: a pool worker IS a GitHub Actions run, so every dispatch leaves one more row in
// the Actions tab of the repository it ran in. The ring sweep (`ring-hygiene`) covers the same ground
// but only when GitHub's `schedule` trigger decides to fire — and in this ring it is delayed by
// hours (measured: the `*/2` pool scaler ran 5h late, and `ring-hygiene` had zero schedule runs in
// its first 13 hours). A worker cannot wait for a cron, so each worker sweeps its own repository on
// the way out. No registry, no extra token: the run deletes its own repository's finished runs with
// `github.token`, which the workflow grants `actions: write` for exactly this step.
//
// What it never deletes: anything that is not `completed`. A live worker in the same repository is
// `in_progress`, a job GitHub has queued is `queued`/`pending` — both are left alone, so the sweep
// cannot kill a sibling worker or itself.
//
// The policy is the same one `ring-hygiene` applies, imported rather than copied: finished runs older
// than `keep-hours` go by age, and at most `max-runs` finished runs are kept per repository. The cap
// is what makes this robust — however many runs accumulated while the pool was busy, one sweep
// brings the tab back under the cap.
//
// Usage: node scripts/zen-pool-prune.mjs [--keep-hours 6] [--max-runs 20] [--dry-run]
//        (needs GITHUB_REPOSITORY and GITHUB_TOKEN, both set by the workflow)

import { planPrune, cutoffIso } from './ring-hygiene.mjs';

const API = 'https://api.github.com';
const GH_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'zen-pool-prune',
};

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function value(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at === process.argv.length - 1) return fallback;
  return process.argv[at + 1];
}

async function gh(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...GH_HEADERS, authorization: `Bearer ${token}` },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 300) };
}

async function listRuns(token, repo, page = 1) {
  const r = await gh('GET', `/repos/${repo}/actions/runs?per_page=100&page=${page}`, token);
  if (!r.ok) return { error: `runs http=${r.status}`, runs: [] };
  return { runs: r.json?.workflow_runs || [] };
}

async function main() {
  const repo = String(process.env.GITHUB_REPOSITORY || '').trim();
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error('zen-pool-prune: GITHUB_REPOSITORY is not set or is not owner/name — nothing to sweep.');
    process.exit(1);
  }
  if (!token) {
    console.error('zen-pool-prune: GITHUB_TOKEN is not set — the workflow must pass github.token.');
    process.exit(1);
  }
  const keepHours = value('keep-hours', '6');
  const maxRuns = value('max-runs', '20');
  const dryRun = flag('dry-run');
  const cutoff = cutoffIso(keepHours);

  const all = [];
  for (let page = 1; page <= 5; page += 1) {
    const { runs, error } = await listRuns(token, repo, page);
    if (error) {
      console.error(`zen-pool-prune: ${error}`);
      process.exit(1);
    }
    all.push(...runs);
    if (runs.length < 100) break;
  }

  const plan = planPrune(all, { cutoffMs: Date.parse(cutoff), max: maxRuns });
  console.log(
    JSON.stringify({
      repo,
      keep_hours: keepHours,
      max_runs: maxRuns,
      dry_run: dryRun,
      listed: all.length,
      to_delete: plan.ids.length,
      by_age: plan.by_age,
      by_cap: plan.by_cap,
      kept: plan.kept,
      live: plan.live,
    }),
  );

  let deleted = 0;
  for (const id of plan.ids) {
    if (dryRun) {
      deleted += 1;
      continue;
    }
    const d = await gh('DELETE', `/repos/${repo}/actions/runs/${id}`, token);
    if (d.ok || d.status === 204 || d.status === 404) deleted += 1;
    else {
      console.error(`zen-pool-prune: delete run ${id} http=${d.status} ${d.text}`);
      process.exit(1);
    }
  }
  console.log(JSON.stringify({ repo, deleted, dry_run: dryRun }));
}

main().catch((e) => {
  console.error(`zen-pool-prune failed: ${e?.message || e}`);
  process.exit(1);
});
