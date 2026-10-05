import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteWorkflowName, isPrunable, cutoffIso, pickRepos, withSelfRow } from '../scripts/ring-hygiene.mjs';

const WF = [
  'name: zen-pool',
  '# a comment that mentions name: inside text',
  'on:',
  '  workflow_dispatch:',
  'jobs: {}',
  '',
].join('\n');

test('rewriteWorkflowName replaces only the top-level name line', () => {
  const r = rewriteWorkflowName(WF, 'Zen Pool — inference worker');
  assert.equal(r.ok, true);
  assert.equal(r.content.split('\n')[0], 'name: Zen Pool — inference worker');
  assert.ok(r.content.includes('# a comment that mentions name: inside text'));
  assert.equal(r.content.split('\n').length, WF.split('\n').length);
});

test('rewriteWorkflowName is a no-op when the name is already there', () => {
  const once = rewriteWorkflowName(WF, 'Zen Pool — inference worker');
  const twice = rewriteWorkflowName(once.content, 'Zen Pool — inference worker');
  assert.equal(twice.ok, false);
  assert.equal(twice.reason, 'already named');
});

test('rewriteWorkflowName refuses an empty file or an empty name', () => {
  assert.equal(rewriteWorkflowName('', 'x').ok, false);
  assert.equal(rewriteWorkflowName(WF, '   ').ok, false);
  assert.equal(rewriteWorkflowName('on: push', 'x').reason, 'no top-level name: line');
});

test('rewriteWorkflowName keeps a multi-line friendly name on one line', () => {
  const r = rewriteWorkflowName(WF, 'Zen Pool\ninference worker');
  assert.equal(r.content.split('\n')[0], 'name: Zen Pool inference worker');
});

test('isPrunable keeps fresh, running and undated runs', () => {
  const cutoff = Date.parse('2026-10-05T00:00:00Z');
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(isPrunable({ created_at: '2026-10-04T23:59:59Z', status: 'completed' }, cutoff, now), true);
  assert.equal(isPrunable({ created_at: '2026-10-05T00:00:00Z', status: 'completed' }, cutoff, now), false);
  assert.equal(isPrunable({ created_at: '2026-10-04T10:00:00Z', status: 'in_progress' }, cutoff, now), false);
  assert.equal(isPrunable({ status: 'completed' }, cutoff, now), false);
  assert.equal(isPrunable({ created_at: 'not-a-date', status: 'completed' }, cutoff, now), false);
});

test('cutoffIso is keep_hours before now and falls back to 24h', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(cutoffIso(6, now), '2026-10-05T06:00:00.000Z');
  assert.equal(cutoffIso(0, now), '2026-10-04T12:00:00.000Z');
  assert.equal(cutoffIso('nonsense', now), '2026-10-04T12:00:00.000Z');
});

test('pickRepos keeps enabled rows, drops malformed ones and honours a filter', () => {
  const rows = [
    { repo: 'llm-tests/llm-tests' },
    { repo: 'vovalikessmoothy-png/gha-worker-01', enabled: true },
    { repo: 'owner/off', enabled: false },
    { repo: 'not a repo' },
    { repo: '' },
  ];
  assert.deepEqual(pickRepos(rows, '').map((r) => r.repo), ['llm-tests/llm-tests', 'vovalikessmoothy-png/gha-worker-01']);
  assert.deepEqual(pickRepos(rows, 'vovalikessmoothy-png/gha-worker-01').map((r) => r.repo), ['vovalikessmoothy-png/gha-worker-01']);
  assert.deepEqual(pickRepos(rows, 'a/b, c/d '), []);
});

test('rewriteWorkflowName reports the OLD name in from', () => {
  const r = rewriteWorkflowName(WF, 'Zen Pool — inference worker');
  assert.equal(r.from, 'name: zen-pool');
  assert.equal(r.content.split('\n')[0], 'name: Zen Pool — inference worker');
});

test('withSelfRow appends the housekeeping repository as a prunable row', () => {
  const rows = [{ repo: 'llm-tests/llm-tests', token: 'ring' }];
  const out = withSelfRow(rows, { repo: 'zen-rings/zen-rings', token: 'self' });
  assert.deepEqual(out.map((r) => r.repo), ['llm-tests/llm-tests', 'zen-rings/zen-rings']);
  assert.equal(out[1].self, true);
  assert.equal(out[1].token, 'self');
  // The self row must survive pickRepos: it is not disabled and matches an empty filter.
  assert.deepEqual(pickRepos(out, '').map((r) => r.repo), ['llm-tests/llm-tests', 'zen-rings/zen-rings']);
});

test('withSelfRow never replaces a registry row and never invents a repository', () => {
  const rows = [{ repo: 'zen-rings/zen-rings', token: 'ring' }];
  assert.deepEqual(withSelfRow(rows, { repo: 'zen-rings/zen-rings', token: 'self' }), rows);
  assert.deepEqual(withSelfRow(rows, { repo: 'not a repo', token: 'self' }), rows);
  assert.deepEqual(withSelfRow(rows, { repo: '', token: 'self' }), rows);
  assert.deepEqual(withSelfRow(rows, {}), rows);
  assert.deepEqual(withSelfRow(null, { repo: 'a/b', token: 't' }).map((r) => r.repo), ['a/b']);
});
