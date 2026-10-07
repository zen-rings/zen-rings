// Ring membership, without the agent and without GitHub secrets.
//
// The ring lives in the worker's D1 registry, so this script is the whole owner-side tool for it:
// add a repository, switch one off, or look at what is in there. Nothing about a token is printed,
// and the token is never a command-line argument — pass it on stdin or in ZEN_RING_ADMIN_TOKEN.
//
//   node scripts/zen-ring.mjs list
//   printf '%s' "$PAT" | node scripts/zen-ring.mjs add owner/name --location eu
//   node scripts/zen-ring.mjs disable owner/name
//
// The admin token (ZEN_RING_ADMIN_TOKEN) is the high-privilege one: it is in this repository's
// Actions secrets and in the owner's shell. A ring member never has it — that is the whole point.

const BASE = process.env.ZEN_RUNNER_URL || 'https://zen-rings.trainedassist.store';
const token = process.env.ZEN_RING_ADMIN_TOKEN || '';

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a non-JSON answer is still an answer */ }
  if (!res.ok) {
    const detail = json?.error || text.slice(0, 200);
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return json;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf.trim()));
    process.stdin.on('error', reject);
  });
}

const [, , cmd, arg, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (!cmd || cmd === 'help' || !token) {
  console.log([
    'Ring membership — the registry is the worker\'s D1, this script is the only interface you need.',
    '',
    '  list                      what is in the ring (no tokens are ever shown)',
    '  add owner/name            add a repo; the PAT is read from stdin (or `--token-ref env:NAME`)',
    '  disable owner/name        switch a row off without deleting it',
    '  location owner/name eu    set the region hint of a row',
    '',
    'Needs ZEN_RING_ADMIN_TOKEN (and ZEN_RUNNER_URL if not the default).',
  ].join('\n'));
  process.exit(token ? 0 : 1);
}

try {
  if (cmd === 'list') {
    const { repos } = await call('GET', '/zen/ring/repos');
    for (const r of repos) {
      const how = r.token_ref ? r.token_ref : r.has_token ? 'stored (encrypted)' : '—';
      console.log(`${r.enabled ? 'on ' : 'off'}  ${r.repo.padEnd(48)} loc=${(r.location || '-').padEnd(4)} token=${how}`);
    }
    console.log(`${repos.length} rows, ${repos.filter((r) => r.enabled).length} enabled`);
  } else if (cmd === 'add') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(arg || '')) throw new Error('usage: add owner/name');
    const tokenRef = flag('token-ref');
    const body = { repo: arg, location: flag('location') || '' };
    if (tokenRef) body.token_ref = tokenRef;
    else body.token = await readStdin();
    if (!body.token_ref && !body.token) throw new Error('no PAT on stdin — nothing to store');
    const res = await call('POST', '/zen/repos', body);
    console.log(`${res.repo} is in the ring (${res.repos.length} rows)`);
  } else if (cmd === 'disable') {
    if (!arg) throw new Error('usage: disable owner/name');
    await call('POST', '/zen/repos', { repo: arg, enabled: false });
    console.log(`${arg} is switched off; re-add it to put it back`);
  } else if (cmd === 'location') {
    if (!arg || !flag('location')) throw new Error('usage: location owner/name <loc>');
    await call('POST', '/zen/repos', { repo: arg, location: flag('location') });
    console.log(`${arg} → location ${flag('location')}`);
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} catch (e) {
  console.error(`zen-ring: ${e.message}`);
  process.exit(1);
}
