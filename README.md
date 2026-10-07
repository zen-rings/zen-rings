# zen-rings

One Cloudflare Worker: a **ring of GitHub Actions repositories** that make the free zen calls.
The hub dispatches to a repo in the ring, that repo's job registers itself, takes a lease, gets a
task and returns the answer — round-robin, so no single address's quota is the ceiling.

Live: `https://zen-rings.trainedassist.store` · worker `zen-rings`, no VM.

This worker serves **only the ring**. There is no `/v1` chat surface, no ladder config and no
model-routing table here — that is a different product in a different repository
(`trained-assist-llm-ladder` / `llm-ladder.trainedassist.store`), and it used to be a copy of this
codebase, which is exactly how the two got mixed up. A ladder worker that wants a free answer
calls this one; a caller that wants completions calls a ladder.

A distinct worker name makes `wrangler deploy` in this repo physically unable to touch the
company ladder worker.

---

## Routes

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness, `{ok:true,service:"zen-ring"}` (no auth) |
| GET | `/zen/health` | registry size + live caps (no auth) |
| GET | `/zen/pool/health` | how many jobs are live right now (no auth) |
| GET | `/zen/pool/metrics` | autoscaler inputs + verdict (`ZEN_RUNNER_TOKEN`) |
| POST | `/zen/pool/scale` | run the autoscaler now (`ZEN_RUNNER_TOKEN`) |
| POST | `/zen/pool/invoke` | `{model,prompt,wait_ms?}` → 200 `{text}` — the ring as one API call (`ZEN_RUNNER_TOKEN`) |
| GET | `/zen/pool/result/{task_id}` | the answer whenever it lands, even after a 504 (`ZEN_RUNNER_TOKEN`) |
| GET | `/zen/result/{run_id}` | the answer to a `/zen/run` dispatch, readable without the run log (`ZEN_RUNNER_TOKEN`) |
| POST | `/zen/pool/register` | a GitHub Actions job registers itself and gets a lease (`ZEN_RUNNER_TOKEN`) |
| GET | `/zen/pool/pull?lease=…` | long-poll for a task; 200 `{bye}` = exit cleanly (`ZEN_RUNNER_TOKEN`) |
| POST | `/zen/pool/result` | the answer (text) + the availability verdict (`ZEN_RUNNER_TOKEN`) |
| POST | `/zen/pool/stop` | tell a job to exit on its next pull (`ZEN_RUNNER_TOKEN`) |
| GET | `/zen/models` | availability table + call-it-or-skip-it verdict (`ZEN_RUNNER_TOKEN`) |
| POST | `/zen/run` | `{model,runs?}` → 202 `run_id` · 409 quarantined · 429 budget · 502 GitHub (`ZEN_RUNNER_TOKEN`) |
| POST | `/zen/report` | `{run_id?,model,ok,kind?,error?}` → the state the caller reads back (`ZEN_RUNNER_TOKEN`) |
| POST | `/zen/repos` | registry row: repo + encrypted token, or `env:NAME` (`ZEN_RING_ADMIN_TOKEN`) |
| GET | `/zen/ring/repos` | the ring as it stands, no tokens in it (`ZEN_RING_ADMIN_TOKEN`) |
| GET | `/zen/ring/payload` | the same list **with** plaintext tokens, decrypted in the worker — what provisioning reads (`ZEN_RING_ADMIN_TOKEN`, `no-store`) |
| GET | `/pool/health` | runs-pool receiver liveness (no auth) |
| POST | `/pool/trigger` | runs-pool dispatch, `POOL_TRIGGER_TOKEN`, body ≤ 8 KB (own token) |

There is no single shared token: every route names its own, because there is no ladder here to
gate behind one.

### The contract (frozen — do not rework)

**Request** — `POST /zen/pool/invoke` with `Authorization: Bearer <ZEN_RUNNER_TOKEN>`:

```json
{ "model": "nemotron-3-ultra-free",
  "messages": [ {"role":"system","content":"…"}, {"role":"user","content":"…"} ],
  "tools": [ {"type":"function","function":{"name":"shell","parameters":{…}}} ],
  "max_tokens": 8192,
  "wait_ms": 20000 }
```

`messages` is the full OpenAI array — that is what a ladder sends. `prompt` is the legacy one-line
fallback. 200 → `{task_id, ok, text, tool_calls, usage, finish_reason, provider_ms, served_ms}`;
non-200 → `{"error": …}` where `429` means budget, `502` provider failure, `503` nothing warm,
`504` watchdog (the task keeps working — poll `/zen/pool/result/{task_id}`).

**Naming — frozen with the 8 ring repositories.** These say `pool` because they are a protocol the
provisioned members already speak; renaming any of them here without re-provisioning every repo
breaks the ring:

| frozen | why |
|---|---|
| HTTP paths `/zen/pool/register\|pull\|result\|stop\|invoke\|metrics\|scale\|health` | the job-side and ops routes the provisioned worker calls |
| `repository_dispatch` type `zen-pool` | each ring repo's workflow declares `types: [zen-pool]` |
| `.github/workflows/zen-pool*.yml`, `scripts/zen-pool*.mjs` | these are the files `zen-ring-sync` copies into every ring repo |

---

## The ring registry

**The ring lives in this worker's D1**, in `zen_repos` — not in a GitHub secret, not in a
spreadsheet. `zen-ring-sync.yml` reads that table (`source: cf`), and `scripts/zen-ring.mjs` is the
owner's interface to it (`list`, `add`, `disable`).

Worker-side: `src/zen-runner.js` (registry, budgets, sweep every 15 min), `src/zen-pool.js` (lease
protocol + autoscaler). Repo-side, each member of the ring carries the same three files —
`.github/workflows/zen-pool.yml`, `scripts/zen-client.mjs`, `scripts/zen-pool-worker.mjs` —
provisioned by `.github/workflows/zen-ring-sync.yml`, so the hub and the members never drift.

Budgets: **50 calls/min, 700/day per model**, providers counted apart (`sharedDayCap` — the shared
counter's day cap is the sum of the independent per-model allowances, so one provider spending its
day cannot refuse another). `/zen/health` is the truth.

**Adding a repository, no agent needed.** Put the new rows in one repository secret named
`ZEN_RING_IMPORT` — a JSON array, one object per repo:

```json
[
  { "repo": "my-org/my-repo", "token": "ghp_…", "location": "" },
  { "repo": "my-org/another", "token": "ghp_…" }
]
```

then run `zen-ring-sync` with `source: gh-import`, `provision: true`, `mode: register`. The workflow
masks every token, writes the rows into the registry encrypted, and provisions the new repositories
(worker files, `ZEN_RUNNER_URL`, `ZEN_RUNNER_TOKEN`). `location` is an optional region hint.
Provisioning needs each repo's token, so the worker decrypts on request behind
`ZEN_RING_ADMIN_TOKEN`; that token is never provisioned into a ring repo, and the low-privilege
`ZEN_RUNNER_TOKEN` that every member *does* hold opens neither the registry nor the payload.

**Open item:** this worker's registry is still empty (`/zen/health` → `repos: 0`) — the live ring
lives in the ladder worker's D1 until it is moved here. Until then the working provisioning runs
from that side; see `zen-ring-sync.yml` here for the file-level source.

---

## Development

```bash
npm ci
npm test               # 110 tests, node:test, no runtime needed
npx wrangler dev       # local worker (cp .dev.vars.example .dev.vars first)
```

`main` is deployed by CI (tests → bundle → D1 schema → worker → smoke). Nothing else deploys.

The deploy job needs five repository secrets — `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `ZEN_RUNNER_TOKEN`,
`ZEN_TOKEN_KEY`, `ZEN_RING_ADMIN_TOKEN`. Without `CF_API_TOKEN` the job does not fail the branch: it
skips the deploy and says so in the run summary, so a fork without Cloudflare access stays green.
`ZEN_RING_ADMIN_TOKEN` is optional: without it the worker keeps `/zen/ring/*` closed and says so in a
warning.

`ZEN_TOKEN_KEY` is the key the ring registry's per-repo tokens are encrypted with. It was copied
over from the repository this project was seeded from and must not be regenerated: a new value
makes every stored ring token undecryptable.

**One deploy-time check cannot be run offline.** The ladder's `LadderState` Durable Object and its
trace D1 are retired in migration `v2` (`deleted_classes`) — they served a chat API this worker no
longer has. Run `wrangler migrations list` before the first deploy after that change and confirm the
deletion is pending.

---

## Docs

| | |
|---|---|
| `docs/zen-runner.md` | runner + ring protocol, registry, budgets |
| `docs/github-actions-zen-client-spec.md` | the GitHub Actions client spec |
| `docs/ring-repo-runbook.md` | what a member of the ring carries |
| `docs/user-scenarios/zen/zen-free-client-from-gha.md` | calling free models from a workflow |
| `docs/free-tier-limits.md` | measured limits of the free tiers |
