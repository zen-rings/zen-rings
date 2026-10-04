import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// scripts/analytics.py is the report path over D1; load it as a module (dash in filename)
// and test the pure parts without any network.
const LOAD = "import importlib.util as u; s = u.spec_from_file_location('an', 'scripts/analytics.py'); m = u.module_from_spec(s); s.loader.exec_module(m)";
const run = (code) => execFileSync('python3', ['-c', `${LOAD}\n${code}`], { encoding: 'utf8', stdio: 'pipe' });

test('analytics: queries bind since as ?1, never interpolated', () => {
  const out = run(`
import json, time
since = int((time.time() - 7 * 86400) * 1000)
qs = m.queries(since)
print(json.dumps({k: [sql, params] for k, (sql, params) in qs.items()}))`);
  const qs = JSON.parse(out);
  assert.deepEqual(Object.keys(qs).sort(),
    ['totals', 'ladders', 'models', 'rungs', 'hourly', 'daily', 'depth', 'errors'].sort());
  for (const [name, [sql, params]] of Object.entries(qs)) {
    assert.match(sql, /\?1/, `${name} must bind ?1`);
    assert.ok(Array.isArray(params) && params.length === 1, `${name} params`);
    assert.ok(!sql.includes(String(params[0])), `${name} must not interpolate the timestamp`);
  }
  assert.match(qs.models[0], /ok = 1/, 'served rungs only come from ok calls');
  assert.match(qs.errors[0], /outcome/, 'errors are pulled from the attempts array');
});

test('analytics: normalize_error merges digit-only variants of one failure', () => {
  const out = run(`
a = m.normalize_error('HTTP 402: {"error":{"message":"can only afford 499"}}')
b = m.normalize_error('HTTP 402: {"error":{"message":"can only afford 776"}}')
c = m.normalize_error('empty answer (finish=length, out=1500, reasoning=1500, prompt=840, max_tokens=1500)')
print(f'{int(a == b)}|{a == c}|{m.normalize_error(None)}|{c}')`);
  const [merged, distinct, noneMsg, plain] = out.trim().split('|');
  assert.equal(merged, '1');
  assert.equal(distinct, 'False');
  assert.equal(noneMsg, '(no message)');
  // #34: the guard error now carries finish/usage — prefix still reads "empty answer", digits masked
  assert.match(plain, /^empty answer \(finish=length, out=#, reasoning=#, prompt=#, max_tokens=#/);
  assert.ok(!/\d/.test(plain), 'token counts are masked for grouping');
});

test('analytics: est_cost bills only paid OpenRouter rungs; Go/free/unknown → None', () => {
  const out = run(`
pricing = {'deepseek/deepseek-v4-flash-0731': {'prompt': 1e-8, 'completion': 1.28e-6},
           'inclusionai/ling-3.0-flash': {'prompt': 2.1e-8, 'completion': 6.3e-8},
           'nvidia/nemotron-3-super-120b-a12b:free': {'prompt': 0, 'completion': 0}}
paid = m.est_cost('openrouter/deepseek/deepseek-v4-flash-0731', 1000000, 1000000, pricing)
free = m.est_cost('openrouter/nvidia/nemotron-3-super-120b-a12b:free', 10**9, 10**9, pricing)
go   = m.est_cost('opencode-go/mimo-v2.6-flash', 10**9, 10**9, pricing)
unk  = m.est_cost('openrouter/vendor/not-in-catalog', 100, 100, pricing)
print(f'{paid:.6f} {free:.6f} {go} {unk} {m.openrouter_id("opencode-go/x")} {m.openrouter_id("openrouter/a/b")}')`);
  const [paid, free, go, unk, goId, orId] = out.trim().split(' ');
  // 1M prompt @ $0.01/M + 1M completion @ $1.28/M
  assert.equal(paid, '1.290000');
  assert.equal(free, '0.000000');
  assert.equal(go, 'None', 'Go subscription is not per-token billed');
  assert.equal(unk, 'None', 'unknown model must not be guessed');
  assert.equal(goId, 'None');
  assert.equal(orId, 'a/b');
});

test('analytics: build_report totals, cache-aware cost rollup, hourly cut, error merge', () => {
  const out = run(`
rows = {
  'totals': [{'n': 10, 'failed': 2, 'avg_ms': 4000, 'tin': 1000, 'tout': 500,
              'ok_n': 8, 'ok_no_usage': 3}],
  'ladders': [{'ladder': 'service', 'n': 10, 'failed': 2, 'avg_ms': 4000}],
  'models': [{'model': 'opencode-go/mimo-v2.6-flash', 'n': 4, 'avg_ms': 5000,
              'tin': 1000000, 'tcached': 400000, 'tout': 500000, 'no_usage': 3},
             {'model': 'opencode-go/space-bunny-free', 'n': 6, 'avg_ms': 3000,
              'tin': 10**9, 'tcached': 0, 'tout': 10**8, 'no_usage': 0}],
  'rungs': [{'ladder': 'service', 'model': 'opencode-go/mimo-v2.6-flash', 'calls': 4,
             'tin': 1000000, 'tcached': 400000, 'tout': 500000}],
  'hourly': [{'hour': '2026-10-02T22:00Z', 'ladder': 'service', 'model': 'opencode-go/mimo-v2.6-flash',
              'calls': 4, 'ok_n': 4, 'tin': 1000000, 'tcached': 400000, 'tout': 500000}],
  'daily': [{'d': '2026-09-30', 'n': 10, 'failed': 2, 'tin': 1000, 'tout': 500}],
  'depth': [{'depth': 1, 'n': 8}, {'depth': 2, 'n': 2}],
  'errors': [{'err': 'HTTP 402: afford 499', 'n': 3},
             {'err': 'HTTP 402: afford 776', 'n': 4},
             {'err': 'empty answer', 'n': 2}],
}
r = m.build_report(rows, {}, 7)
print(r['totals']['calls'], r['totals']['ok_rate'], round(r['totals']['est_cost_usd'], 5),
      len(r['models']), round(r['models'][0]['cost'], 5), r['models'][1]['cost'],
      len(r['errors']), r['errors'][0]['n'],
      len(r['hourly']), round(r['hourly'][0]['cost'], 5), round(r['rungs'][0]['cost'], 5))
md = m.render_markdown(r)
print('Ladder analytics' in md, 'failover' in md.lower() or 'attempts' in md.lower(), 'HTTP' in md, 'Hourly' in md)`);
  const [l1, l2] = out.trim().split('\n');
  const [calls, okRate, cost, nModels, firstCost, freeCost, nErr, topN, nHourly, hourlyCost, rungCost] = l1.split(' ');
  assert.equal(calls, '10');
  assert.equal(okRate, '0.8');
  // cache-aware: fresh 600k @0.14 + out 500k @0.28 + cached 400k @0.0028 = 0.084+0.14+0.00112 = 0.22512
  assert.equal(cost, '0.22512');
  assert.equal(nModels, '2');
  assert.equal(firstCost, '0.22512');
  assert.equal(freeCost, '0', 'Go free rung costs $0');
  assert.equal(nErr, '2');
  assert.equal(topN, '7');
  assert.equal(nHourly, '1');
  assert.equal(hourlyCost, '0.22512');
  assert.equal(rungCost, '0.22512');
  const [hasTitle, hasDepth, hasErr, hasHourly] = l2.split(' ');
  assert.equal(hasTitle, 'True');
  assert.equal(hasDepth, 'True');
  assert.equal(hasErr, 'True', 'top errors table renders (normalized: HTTP #)');
  assert.equal(hasHourly, 'True', 'hourly cut renders');
});
