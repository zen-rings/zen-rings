import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'zen-pool-prune.mjs');

// The sweep runs at the end of every pool worker, so its failure modes are the ones that would
// silently leave a repository dirty: no token, no repository, or a token that cannot read runs.
// Each of those must be a loud exit 1, never a quiet success.

function run(env) {
  // The ambient environment may carry a token of its own; a test about a missing variable has to
  // remove it, not just fail to set it.
  const base = { ...process.env };
  delete base.GITHUB_TOKEN;
  delete base.GITHUB_REPOSITORY;
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { ...base, ...env },
      encoding: 'utf8',
      timeout: 30000,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('refuses to sweep without GITHUB_REPOSITORY', () => {
  const r = run({ GITHUB_TOKEN: 'x' });
  assert.equal(r.code, 1);
  assert.match(r.out, /GITHUB_REPOSITORY/);
});

test('refuses to sweep without GITHUB_TOKEN', () => {
  const r = run({ GITHUB_REPOSITORY: 'zen-rings/zen-rings' });
  assert.equal(r.code, 1);
  assert.match(r.out, /GITHUB_TOKEN/);
});

test('refuses a malformed repository name instead of guessing one', () => {
  const r = run({ GITHUB_REPOSITORY: 'not a repo', GITHUB_TOKEN: 'x' });
  assert.equal(r.code, 1);
  assert.match(r.out, /GITHUB_REPOSITORY/);
});

test('a token that cannot read runs is a failure, not a clean sweep', () => {
  const r = run({ GITHUB_REPOSITORY: 'zen-rings/zen-rings', GITHUB_TOKEN: 'not-a-real-token' });
  assert.equal(r.code, 1);
  assert.match(r.out, /runs http=401/);
});
