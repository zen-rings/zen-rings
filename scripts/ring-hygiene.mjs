#!/usr/bin/env node
// Housekeeping for the repositories in the Zen Pool ring.
//
// Why this exists: every pool worker is a GitHub Actions run, so a busy ring fills the Actions tab of
// each member repository with dozens of identical `zen-pool` runs that nobody will ever read. The REST
// API has no bulk endpoint for that (`DELETE /repos/{o}/{r}/actions/runs?created=` answers 404) and no
// retention setting at all (`actions/permissions/retention` and friends answer 404 too), so pruning has
// to be done run by run.
//
// The ring's per-repository tokens are read from the worker registry (see zen-ring-sync.yml) and used
// here at CI runtime only: they are never an input, never printed, never written to a file this script
// keeps. `add-mask` is applied by the caller before this runs.
//
// Modes (all optional, all default to a no-op):
//   prune_runs        delete finished runs older than keep_hours
//   prune_artifacts   delete artifacts older than keep_hours
//   harden            make sure Actions are enabled and the default workflow token is read-only
//   rename_workflows  give the pool workflow a human-readable display name (the `name:` line only,
//                     nothing that can change how the worker behaves)
//
// Usage: node scripts/ring-hygiene.mjs [--ring .ring/ring.json] [--keep-hours 24] [--repos a/b,c/d]
//        [--prune-runs] [--prune-artifacts] [--harden] [--rename-workflows]
//        [--friendly-name "Zen Pool — inference worker"] [--dry-run]

import { readFileSync } from 'node:fs';

const API = 'https://api.github.com';
const WORKER_WORKFLOW = '.github/workflows/zen-pool.yml';
const GH_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'zen-ring-hygiene',
};

export function rewriteWorkflowName(content, friendlyName) {
  if (typeof content !== 'string' || !content.trim()) return { ok: false, reason: 'empty file' };
  if (!friendlyName || !friendlyName.trim()) return { ok: false, reason: 'no friendly name given' };
  const name = friendlyName.replace(/[\r\n]+/g, ' ').trim();
  const lines = content.split('\n');
  const at = lines.findIndex((l) => /^name:\s*\S/.test(l));
  if (at === -1) return { ok: false, reason: 'no top-level name: line' };
  if (lines[at].replace(/^name:\s*/, '').trim() === name) return { ok: false, reason: 'already named' };
  lines[at] = `name: ${name}`;
  return { ok: true, content: lines.join('\n'), from: lines[at] };
}

export function isPrunable(item, cutoffMs, nowMs) {
  if (!item || typeof item.created_at !== 'string') return false;
  const created = Date.parse(item.created_at);
  if (!Number.isFinite(created)) return false;
  if (created >= cutoffMs) return false;
  if (item.status && item.status !== 'completed') return false;
  if (nowMs != null && created > nowMs) return false;
  return true;
}

export function cutoffIso(keepHours, nowMs = Date.now()) {
  const hours = Number(keepHours);
  const safe = Number.isFinite(hours) && hours > 0 ? hours : 24;
  return new Date(nowMs - safe * 3600 * 1000).toISOString();
}

export function pickRepos(rows, filter) {
  const wanted = String(filter || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return rows
    .filter((r) => r && /^[\w.-]+\/[\w.-]+$/.test(r.repo || ''))
    .filter((r) => r.enabled !== false)
    .filter((r) => !wanted.length || wanted.includes(r.repo));
}

async function gh(token, method, path, body) {
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

async function listRuns(token, repo, cutoff, page = 1) {
  const q = `per_page=100&page=${page}&created=<${encodeURIComponent(cutoff)}`;
  const r = await gh(token, 'GET', `/repos/${repo}/actions/runs?${q}`);
  if (!r.ok) return { error: `runs http=${r.status}`, runs: [] };
  return { runs: r.json?.workflow_runs || [] };
}

async function pruneRuns(token, repo, cutoff, dryRun) {
  const seen = [];
  for (let page = 1; page <= 5; page += 1) {
    const { runs, error } = await listRuns(token, repo, cutoff, page);
    if (error) return { deleted: seen.length, error };
    if (!runs.length) break;
    for (const run of runs) {
      if (!isPrunable(run, Date.parse(cutoff))) continue;
      seen.push(run.id);
      if (dryRun) continue;
      const d = await gh(token, 'DELETE', `/repos/${repo}/actions/runs/${run.id}`);
      if (!d.ok && d.status !== 204 && d.status !== 404) return { deleted: seen.length - 1, error: `delete run ${run.id} http=${d.status}` };
    }
    if (runs.length < 100) break;
  }
  return { deleted: seen.length };
}

async function pruneArtifacts(token, repo, cutoff, dryRun) {
  const r = await gh(token, 'GET', `/repos/${repo}/actions/artifacts?per_page=100&created=<${encodeURIComponent(cutoff)}`);
  if (!r.ok) return { deleted: 0, error: `artifacts http=${r.status}` };
  const arts = (r.json?.artifacts || []).filter((a) => isPrunable(a, Date.parse(cutoff)));
  let deleted = 0;
  for (const a of arts) {
    if (dryRun) {
      deleted += 1;
      continue;
    }
    const d = await gh(token, 'DELETE', `/repos/${repo}/actions/artifacts/${a.id}`);
    if (d.ok || d.status === 404) deleted += 1;
  }
  return { deleted };
}

async function harden(token, repo, dryRun) {
  const cur = await gh(token, 'GET', `/repos/${repo}/actions/permissions`);
  if (!cur.ok) return { changed: false, error: `permissions http=${cur.status}` };
  const want = { enabled: true, default_workflow_permissions: 'read' };
  if (cur.json?.enabled === true && cur.json?.default_workflow_permissions === 'read') {
    return { changed: false, ok: true };
  }
  if (dryRun) return { changed: true, applied: false };
  const put = await gh(token, 'PUT', `/repos/${repo}/actions/permissions`, want);
  return { changed: true, applied: put.ok, error: put.ok ? undefined : `put http=${put.status}` };
}

async function renameWorkflow(token, repo, friendlyName, dryRun) {
  const cur = await gh(token, 'GET', `/repos/${repo}/contents/${WORKER_WORKFLOW}`);
  if (!cur.ok) return { changed: false, error: `read ${WORKER_WORKFLOW} http=${cur.status}` };
  const content = Buffer.from(cur.json.content || '', 'base64').toString('utf8');
  const next = rewriteWorkflowName(content, friendlyName);
  if (!next.ok) return { changed: false, reason: next.reason };
  if (dryRun) return { changed: true, from: next.from, applied: false };
  const put = await gh(
    token,
    'PUT',
    `/repos/${repo}/contents/${WORKER_WORKFLOW}`,
    {
      message: `zen-pool: give the workflow a readable display name`,
      content: Buffer.from(next.content, 'utf8').toString('base64'),
      sha: cur.json.sha,
      branch: cur.json.default_branch || 'main',
    },
  );
  return { changed: true, applied: put.ok, error: put.ok ? undefined : `put http=${put.status}` };
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function value(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at === process.argv.length - 1) return fallback;
  return process.argv[at + 1];
}

async function main() {
  const ringPath = value('ring', '.ring/ring.json');
  const rows = JSON.parse(readFileSync(ringPath, 'utf8'));
  const keepHours = value('keep-hours', '24');
  const cutoff = cutoffIso(keepHours);
  const friendly = value('friendly-name', 'Zen Pool — inference worker');
  const dryRun = flag('dry-run');
  const doRuns = flag('prune-runs');
  const doArtifacts = flag('prune-artifacts');
  const doHarden = flag('harden');
  const doRename = flag('rename-workflows');
  const repos = pickRepos(rows, value('repos', ''));
  console.log(
    JSON.stringify({ ring_rows: Array.isArray(rows) ? rows.length : 0, repos: repos.length, cutoff, keep_hours: keepHours, dry_run: dryRun }),
  );
  if (!repos.length) {
    console.log('nothing to do — no enabled ring rows matched');
    return;
  }
  const report = [];
  for (const row of repos) {
    const repo = row.repo;
    const token = row.token || row.resolved_token || '';
    const entry = { repo };
    if (!token) {
      entry.error = 'no token in the registry for this row';
      report.push(entry);
      continue;
    }
    if (doRuns) entry.runs = await pruneRuns(token, repo, cutoff, dryRun);
    if (doArtifacts) entry.artifacts = await pruneArtifacts(token, repo, cutoff, dryRun);
    if (doHarden) entry.harden = await harden(token, repo, dryRun);
    if (doRename) entry.rename = await renameWorkflow(token, repo, friendly, dryRun);
    report.push(entry);
  }
  console.log(JSON.stringify({ hygiene: report }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`ring-hygiene failed: ${e?.message || e}`);
    process.exit(1);
  });
}