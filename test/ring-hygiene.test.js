import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rewriteWorkflowName,
  isPrunable,
  cutoffIso,
  pickRepos,
  withSelfRow,
  isFinished,
  planPrune,
  ensureWorkerSweep,
  DEFAULT_KEEP_HOURS,
  DEFAULT_MAX_ITEMS,
} from '../scripts/ring-hygiene.mjs';

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

test('cutoffIso is keep_hours before now and falls back to 27 minutes', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(cutoffIso(6, now), '2026-10-05T06:00:00.000Z');
  assert.equal(cutoffIso(DEFAULT_KEEP_HOURS, now), '2026-10-05T11:33:00.000Z');
  assert.equal(cutoffIso(0, now), '2026-10-05T11:33:00.000Z');
  assert.equal(cutoffIso('nonsense', now), '2026-10-05T11:33:00.000Z');
});

test('the default window is 27 minutes and the cap is 20', () => {
  assert.equal(DEFAULT_KEEP_HOURS * 60, 27);
  assert.equal(DEFAULT_MAX_ITEMS, 20);
});

test('isFinished only ever accepts a completed item', () => {
  assert.equal(isFinished({ created_at: '2026-10-05T00:00:00Z', status: 'completed' }), true);
  assert.equal(isFinished({ created_at: '2026-10-05T00:00:00Z' }), true);
  assert.equal(isFinished({ created_at: '2026-10-05T00:00:00Z', status: 'in_progress' }), false);
  assert.equal(isFinished({ created_at: '2026-10-05T00:00:00Z', status: 'queued' }), false);
  assert.equal(isFinished({ created_at: '2026-10-05T00:00:00Z', status: 'pending' }), false);
  assert.equal(isFinished({ created_at: '2026-10-05T00:00:00Z', status: 'waiting' }), false);
  assert.equal(isFinished({ created_at: '2026-10-05T00:00:00Z', status: 'requested' }), false);
  assert.equal(isFinished({ created_at: '2026-10-05T00:00:00Z', status: 'expired' }), false);
  assert.equal(isFinished({ created_at: 'not-a-date', status: 'completed' }), false);
  assert.equal(isFinished(null), false);
});

test('planPrune deletes by age, caps the rest and never touches live work', () => {
  const cutoff = Date.parse('2026-10-05T06:00:00Z');
  const now = Date.parse('2026-10-05T12:00:00Z');
  const run = (id, at, status = 'completed') => ({ id, created_at: at, status });
  const items = [
    run(1, '2026-10-05T11:00:00Z'), // fresh, kept
    run(2, '2026-10-05T10:00:00Z'), // fresh, kept
    run(3, '2026-10-05T09:00:00Z'), // fresh, kept
    run(4, '2026-10-05T08:00:00Z'), // fresh, kept
    run(5, '2026-10-05T07:00:00Z'), // fresh, kept
    run(6, '2026-10-05T05:00:00Z'), // older than the window
    run(7, '2026-10-05T04:00:00Z'), // older than the window
    run(8, '2026-10-05T11:30:00Z', 'in_progress'), // a live pool worker
    run(9, '2026-10-05T11:45:00Z', 'queued'), // queued, will start in a minute
  ];
  const plan = planPrune(items, { cutoffMs: cutoff, max: 5, nowMs: now });
  assert.deepEqual(plan.ids, [6, 7]);
  assert.equal(plan.by_age, 2);
  assert.equal(plan.by_cap, 0);
  assert.equal(plan.kept, 5);
  assert.equal(plan.live, 2);
});

test('planPrune keeps the newest max finished runs and drops the rest by cap', () => {
  const cutoff = Date.parse('2026-10-05T06:00:00Z');
  const now = Date.parse('2026-10-05T12:00:00Z');
  const run = (id, at) => ({ id, created_at: at, status: 'completed' });
  const items = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => run(i, `2026-10-05T0${i}:00:00Z`));
  const plan = planPrune(items, { cutoffMs: cutoff, max: 3, nowMs: now });
  assert.deepEqual(plan.ids, [5, 4, 3, 2, 1]);
  assert.equal(plan.by_age, 5);
  assert.equal(plan.by_cap, 0);
  assert.equal(plan.kept, 3);
  assert.equal(plan.live, 0);
});

test('planPrune applies the cap to the newest runs even when the list is not sorted', () => {
  const cutoff = Date.parse('2026-10-05T06:00:00Z');
  const now = Date.parse('2026-10-05T12:00:00Z');
  const run = (id, at) => ({ id, created_at: at, status: 'completed' });
  const items = [
    run(3, '2026-10-05T09:00:00Z'),
    run(1, '2026-10-05T11:00:00Z'),
    run(2, '2026-10-05T10:00:00Z'),
  ];
  const plan = planPrune(items, { cutoffMs: cutoff, max: 2, nowMs: now });
  assert.deepEqual(plan.ids, [3]);
  assert.equal(plan.kept, 2);
});

test('planPrune treats a non-positive or missing cap as no cap', () => {
  const cutoff = Date.parse('2026-10-05T06:00:00Z');
  const now = Date.parse('2026-10-05T12:00:00Z');
  const run = (id, at) => ({ id, created_at: at, status: 'completed' });
  const items = [1, 2, 3].map((i) => run(i, `2026-10-05T0${i + 6}:00:00Z`));
  for (const max of [0, -1, 'nonsense', undefined, null]) {
    const plan = planPrune(items, { cutoffMs: cutoff, max, nowMs: now });
    assert.equal(plan.by_cap, 0, `max=${max}`);
    assert.equal(plan.kept, 3, `max=${max}`);
  }
});

test('planPrune ignores items without an id and items from the future', () => {
  const cutoff = Date.parse('2026-10-05T06:00:00Z');
  const now = Date.parse('2026-10-05T12:00:00Z');
  const plan = planPrune(
    [
      { created_at: '2026-10-05T05:00:00Z', status: 'completed' },
      { id: 1, created_at: '2026-10-05T13:00:00Z', status: 'completed' },
      { id: 2, created_at: '2026-10-05T05:00:00Z', status: 'completed' },
    ],
    { cutoffMs: cutoff, max: 20, nowMs: now },
  );
  assert.deepEqual(plan.ids, [2]);
  assert.equal(plan.kept, 0);
  assert.equal(plan.live, 1);
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

test('ensureWorkerSweep adds the permission and the step to a provisioned worker workflow', () => {
  const WF = [
    'name: zen-pool',
    'on:',
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  pool:',
    '    steps:',
    '      - name: serve',
    '        run: node scripts/zen-pool-worker.mjs',
    '      - name: boot summary',
    '        if: always()',
    '        run: echo done',
    '',
  ].join('\n');
  const r = ensureWorkerSweep(WF);
  assert.equal(r.ok, true);
  const out = r.content;
  assert.match(out, /^  actions: write$/m);
  assert.ok(out.indexOf('sweep own finished runs') < out.indexOf('boot summary'));
  assert.ok(out.indexOf('sweep own finished runs') > out.indexOf('- name: serve'));
  assert.ok(out.includes(`node scripts/zen-pool-prune.mjs --keep-hours ${DEFAULT_KEEP_HOURS} --max-runs ${DEFAULT_MAX_ITEMS}`));
});

test('ensureWorkerSweep is idempotent and refuses a file it cannot place the step in', () => {
  const once = ensureWorkerSweep(
    ['permissions:', '  contents: read', 'jobs:', '  pool:', '    steps:', '      - name: boot summary', '        run: x', ''].join('\n'),
  );
  assert.equal(once.ok, true);
  const twice = ensureWorkerSweep(once.content);
  assert.equal(twice.ok, false);
  assert.equal(twice.reason, 'already swept');
  assert.equal(ensureWorkerSweep('').ok, false);
  assert.equal(ensureWorkerSweep('name: x\njobs: {}').reason, 'no boot summary step to insert before');
});

test('a sweep step provisioned with the old window is refreshed, not left as a no-op', () => {
  const stale = [
    '      - name: sweep own finished runs',
    '        run: |',
    '          node scripts/zen-pool-prune.mjs --keep-hours 6 --max-runs 20',
    '      - name: boot summary',
    '',
  ].join('\n');
  const refreshed = ensureWorkerSweep(stale);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.reason, 'sweep args refreshed');
  assert.equal(refreshed.from, 'node scripts/zen-pool-prune.mjs --keep-hours 6 --max-runs 20');
  assert.ok(refreshed.content.includes(`node scripts/zen-pool-prune.mjs --keep-hours ${DEFAULT_KEEP_HOURS} --max-runs ${DEFAULT_MAX_ITEMS}`));
  assert.ok(!refreshed.content.includes('--keep-hours 6'));
  assert.equal(refreshed.content.split('sweep own finished runs').length, 2);
  assert.equal(ensureWorkerSweep(refreshed.content).reason, 'already swept');
});
