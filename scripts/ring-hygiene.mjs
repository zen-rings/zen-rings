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
// `--self owner/name` adds the repository this script runs in as one more row to prune, with its token
// taken from ZEN_HYGIENE_SELF_TOKEN. Without it the repository that owns the housekeeping workflow is
// the one repository whose Actions tab nobody ever prunes — this sweep is what keeps that from growing
// forever. `--self` never changes the ring registry, so it cannot make this repository a dispatch
// target, and it only ever prunes runs/artifacts here: harden and rename are ring-wide settings and
// stay on registry rows, which are the rows that justify them.
//
// Usage: node scripts/ring-hygiene.mjs [--ring .ring/ring.json] [--keep-hours 24] [--repos a/b,c/d]
//        [--prune-runs] [--prune-artifacts] [--harden] [--rename-workflows] [--self owner/name]
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
  const from = lines[at];
  lines[at] = `name: ${name}`;
  return { ok: true, content: lines.join('\n'), from };
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

// A ring row is a promise that the repository may be dispatched to and hardened, so it is never
// replaced here. The self row is appended only when the repository is not in the ring at all — that is
// the normal case for the housekeeping repository itself, which has no business being a pool target.
export function withSelfRow(rows, self) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.repo);
  const repo = String(self?.repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return list;
  if (list.some((r) => r.repo === repo)) return list;
  return [...list, { repo, token: String(self?.token || ''), self: true }];
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
  // `default_workflow_permissions` does not appear in GET /actions/permissions (that one answers
  // {enabled, allowed_actions}); it lives on /actions/permissions/workflow. Read it from there, or
  // the check would report "changed" on every single run.
  const cur = await gh(token, 'GET', `/repos/${repo}/actions/permissions`);
  if (!cur.ok) return { changed: false, error: `permissions http=${cur.status}` };
  const wf = await gh(token, 'GET', `/repos/${repo}/actions/permissions/workflow`);
  const enabled = cur.json?.enabled === true;
  const readOnly = wf.ok && wf.json?.default_workflow_permissions === 'read';
  if (enabled && readOnly) return { changed: false, ok: true };
  if (dryRun) return { changed: true, applied: false, enabled, read_only: readOnly };
  const a = enabled ? { ok: true } : await gh(token, 'PUT', `/repos/${repo}/actions/permissions`, { enabled: true });
  const b = readOnly ? { ok: true } : await gh(token, 'PUT', `/repos/${repo}/actions/permissions/workflow`, { default_workflow_permissions: 'read' });
  const ok = a.ok && b.ok;
  return { changed: true, applied: ok, error: ok ? undefined : `put enabled=${a.ok} workflow=${b.ok}` };
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
  const selfRepo = value('self', '');
  const selfToken = process.env.ZEN_HYGIENE_SELF_TOKEN || '';
  const selfAdded = selfRepo && selfToken ? withSelfRow(rows, { repo: selfRepo, token: selfToken }) : rows;
  const repos = pickRepos(selfAdded, value('repos', ''));
  console.log(
    JSON.stringify({
      ring_rows: Array.isArray(rows) ? rows.length : 0,
      repos: repos.length,
      self: selfRepo && selfToken ? selfRepo : 'off',
      cutoff,
      keep_hours: keepHours,
      dry_run: dryRun,
    }),
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
    if (row.self) entry.self = true;
    if (!token) {
      entry.error = 'no token in the registry for this row';
      report.push(entry);
      continue;
    }
    if (doRuns) entry.runs = await pruneRuns(token, repo, cutoff, dryRun);
    if (doArtifacts) entry.artifacts = await pruneArtifacts(token, repo, cutoff, dryRun);
    // harden and rename change how workflows of a repository run; only a registry row justifies that,
    // so the self row prunes and nothing else.
    if (doHarden && !row.self) entry.harden = await harden(token, repo, dryRun);
    if (doRename && !row.self) entry.rename = await renameWorkflow(token, repo, friendly, dryRun);
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