import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFromClaim } from '../scripts/zen-pool-scale.mjs';

// The regression these cover (issue #14, live run 37265914523): `zen-pool-scale -f demand=2`
// with one live worker printed `toDispatch=0 reason=at_target` and dispatched nothing, because the
// early exit read the verdict from /zen/pool/metrics — an endpoint that never sees `demand`.
const IDLE = { workers_live: 1, inflight: 0, toDispatch: 0, queued: 0 };

test('a claim of 2 with one live worker asks for exactly one more', () => {
  const p = planFromClaim(IDLE, { demand: 2 });
  assert.equal(p.want, 2);
  assert.equal(p.toDispatch, 1);
  assert.equal(p.atTarget, false);
});

test('a claim of 1 with one live worker is already at target', () => {
  const p = planFromClaim(IDLE, { demand: 1 });
  assert.equal(p.toDispatch, 0);
  assert.equal(p.atTarget, true);
});

test('inflight workers count as busy: claim 2 with 1 live + 1 inflight needs nothing', () => {
  const p = planFromClaim({ workers_live: 1, inflight: 1, toDispatch: 0 }, { demand: 2 });
  assert.equal(p.busy, 2);
  assert.equal(p.toDispatch, 0);
  assert.equal(p.atTarget, true);
});

test('no claim keeps the metrics verdict, including a queue-driven one', () => {
  assert.equal(planFromClaim({ workers_live: 1, inflight: 0, toDispatch: 2 }, {}).toDispatch, 2);
  assert.equal(planFromClaim({ workers_live: 3, inflight: 0, toDispatch: 0 }, {}).atTarget, true);
});

test('force still overrides an at-target verdict and asks for 2', () => {
  const p = planFromClaim({ workers_live: 9, inflight: 0, toDispatch: 0 }, { force: true });
  assert.equal(p.want, 2);
  assert.equal(p.atTarget, false, 'force must never exit early');
});

test('force with an empty pool asks for 2, not for 0', () => {
  assert.equal(planFromClaim({ workers_live: 0, inflight: 0, toDispatch: 0 }, { force: true }).toDispatch, 2);
});

test('garbage in the metrics cannot produce a negative dispatch', () => {
  const p = planFromClaim({ workers_live: 'x', inflight: null, toDispatch: -4 }, { demand: 3 });
  assert.equal(p.live, 0);
  assert.equal(p.inflight, 0);
  assert.equal(p.toDispatch, 3);
  assert.equal(planFromClaim({}, {}).toDispatch, 0);
});

test('a claim below what is already live never asks to shrink the pool', () => {
  const p = planFromClaim({ workers_live: 5, inflight: 0, toDispatch: 0 }, { demand: 2 });
  assert.equal(p.toDispatch, 0);
  assert.equal(p.atTarget, true);
});