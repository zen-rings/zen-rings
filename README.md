# LLM API + LLM pool

One Cloudflare Worker, two jobs:

1. **LLM API** — `POST /v1/chat/completions`, OpenAI-compatible. You name a *ladder* (an ordered
   list of models); the API walks it top-down and answers from the first model that works.
2. **LLM pool** — a ring of GitHub Actions repos that make the free calls for you, round-robin,
   so no single address's quota is the ceiling.

Live: `https://llm-ladder.trainedassist.store` · worker `trained-assist-llm-ladder`, no VM.

---

## 1. LLM API

```bash
curl https://llm-ladder.trainedassist.store/v1/chat/completions \
  -H "Authorization: Bearer $LADDER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"service","messages":[{"role":"user","content":"11 + 13 = ?"}]}'
```

`model` = ladder name. The reply's `model` field names the rung that actually answered (also in
`x-ladder-model`), so a caller can see what it paid for.

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness + ladder names (no auth) |
| GET | `/v1/models` | ladders as model ids (auth) |
| POST | `/v1/chat/completions` | the call; `stream:true` → SSE; `tools` passed through |
| GET | `/v1/state` | model health + key-rotation snapshot (auth) |
| POST | `/v1/state/reset-keys` | unpark all Go subscription keys (auth, ops lever) |
| GET | `/v1/go-usage` | remaining Go allowance per pool key (auth) |
| GET | `/v1/analytics?hours=N` | per-ladder × model calls, tokens, `cost_usd`, hourly cut, errors (auth) |
| GET | `/v1/calls?trace=…` | the per-call trace of one request — needs `trace`, `user`, `chat` or `session` (auth) |

Auth = `Authorization: Bearer <LADDER_TOKEN>` everywhere except `/health`. `GET /v1/calls` is the
replacement for the old laptop script that read the trace database — no Cloudflare token needed.

Optional body fields: `ladder_timeout_ms` (per rung, 20000), `ladder_ttfb_ms` (stream first-token
window, 15000), `ladder_total_timeout_ms` (whole ladder), `ladder_rung` (pin one rung, no
failover — for benchmarks), `ladder_conversation` (sticky-rung key: one conversation stays on one
rung until it hard-fails).

OpenRouter attribution: send `x-ladder-app: <slug>` and `x-ladder-app-title`.

### Ladders = the routing table

`config/ladders.json` is the only source of truth. **One name, one ladder, no aliases** — a
request for a name that does not exist gets `404 unknown ladder: <name>`, loudly. `GET /v1/models`
lists the current 13.

| group | names |
|---|---|
| service calls (the default) | `service` and `service:<role>` — `classify`, `summarize`, `format`, `route`, `gate` |
| interactive work | `build`, `build advanced`, `plan`, `explore`, `general`, `review` |
| free ceiling | `free` — hard $0, never spends money |
| specialists | `doctor` (strongest), `research`, `conversation`, `vision`, `vision advanced` |

Rung prefixes: `opencode-go/*` (subscription, per-model monthly limits), `openrouter/*`
(pay-per-token, `:free` is $0), `opencode-zen/*` (Zen free tier through the GCP relay,
`scripts/zen-relay.mjs`).

How a call resolves: pick the ladder → skip models whose health is bad (per-model backoff 15s →
30s → … cap 5 min) → on a *key*-level fault rotate to the next subscription key and retry the same
rung → guard rejects empty content or non-JSON when `response_format: json_object` → walk down
until one answers.

Rules for changing it:

- Editing `config/ladders.json` means editing the **order of models**, not the router code.
- A ladder **name** is a breaking change: run the contract guard (below) before merging — it
  lists every ladder id the clients actually send and fails if one no longer resolves.
- Zen free rungs live in the free tail only — never ahead of a working free rung.

## 2. Pool

The API above leans on free tiers, and free tiers are metered per address. The pool turns "this
GitHub Actions runner" into a callable resource: the hub dispatches to a repo in the ring, that
repo's job registers itself, gets a task and returns the answer.

| Method | Path | |
|---|---|---|
| GET | `/zen/health` | registry size + live caps (no auth) |
| POST | `/zen/pool/invoke` | `{model,prompt,wait_ms?}` → 200 `{text}` — the pool as one API call (own token) |
| GET | `/zen/pool/health` | how many jobs are live right now (no auth) |
| POST | `/zen/repos` | registry row: repo + encrypted token, or `env:NAME` — the ring (`ZEN_RING_ADMIN_TOKEN`) |
| GET | `/zen/ring/repos` | the ring as it stands, no tokens in it (`ZEN_RING_ADMIN_TOKEN`) |
| GET | `/zen/ring/payload` | the same list **with** plaintext tokens, decrypted in the worker — what provisioning reads (`ZEN_RING_ADMIN_TOKEN`, `no-store`) |
| GET | `/zen/models` | availability table + call-it-or-skip-it verdict (auth) |
| POST | `/zen/run` | `{model,runs?}` → 202 `run_id` · 409 quarantined · 429 budget · 502 GitHub (auth) |

Worker-side: `src/zen-runner.js` (registry, budgets, sweep every 15 min), `src/zen-pool.js` (lease
protocol). Repo-side, each member of the ring carries the same three files — `.github/workflows/
zen-pool.yml`, `scripts/zen-client.mjs`, `scripts/zen-pool-worker.mjs` — provisioned by
`.github/workflows/zen-ring-sync.yml`, so the hub repo and the members never drift.

Budgets are per model: 50 calls/min, 500/day, registry of 9 repos. `/zen/health` is the truth.

**The ring lives in this worker's D1**, in `zen_repos` — not in a GitHub secret, not in a
spreadsheet. `zen-ring-sync.yml` reads that table (`source: cf`), and `scripts/zen-ring.mjs` is the
owner's interface to it (`list`, `add`, `disable`). Provisioning needs each repo's token, so the
worker decrypts on request behind `ZEN_RING_ADMIN_TOKEN`; that token is never provisioned into a ring
repo, and the low-privilege `ZEN_RUNNER_TOKEN` that every member *does* hold opens neither the
registry nor the payload.

## Development

```bash
npm ci
npm test                       # 159 tests, node:test, no runtime needed
npm run gate                   # live gate: one pinned call per rung against prod
npx wrangler dev               # local worker (cp .dev.vars.example .dev.vars first)

# before renaming or removing a ladder: fails if a client still sends a name that is gone
node scripts/check-client-contracts.mjs ~/.config/opencode/opencode.json <vm opencode.json> <agent provider>
```

`main` is deployed by CI (tests → D1 schema → worker → smoke). Nothing else deploys.

The deploy job needs five repository secrets — `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `ZEN_RUNNER_TOKEN`,
`ZEN_TOKEN_KEY`, `ZEN_RING_ADMIN_TOKEN`. Without `CF_API_TOKEN` the job does not fail the branch: it
skips the deploy and says so in the run summary, so a fork without Cloudflare access stays green.
`ZEN_RING_ADMIN_TOKEN` is optional: without it the worker keeps `/zen/ring/*` closed and says so in a
warning.

`ZEN_TOKEN_KEY` is the key the pool registry's per-repo tokens are encrypted with. It was
copied over from the repository this project was seeded from and must not be regenerated: a new
value makes every stored ring token undecryptable.

This repository is the product home; the old one only keeps the schedules switched off.
`ladder-analytics`, `zen-pool-scale` and `zen-selftest` are `disabled_manually` there and active
here — exactly one repo asks the hub for workers, so the autoscale cron (`*/2 * * * *`) never
fires twice for the same tick. Delete the old repository once nothing points at it.

Gate/live tokens come from `$LADDER_TOKEN` or `~/.llm-ladder-token` (chmod 600, outside the repo) —
read them inside the script, never echo them into a prompt or a file in the repo.

## Docs

| | |
|---|---|
| `docs/zen-runner.md` | runner + pool protocol, registry, budgets |
| `docs/github-actions-zen-client-spec.md` | the GitHub Actions client spec |
| `docs/user-scenarios/zen/zen-free-client-from-gha.md` | calling free models from a workflow |
| `docs/user-scenarios/ladder/sticky-rung-per-conversation.md` | sticky rung scenario |
| `docs/free-tier-limits.md` | measured limits of the free tiers |
| `docs/go-key-management.md` | subscription key pool, parking, rotation |
| `docs/requirements-log.md` | what the owner asked for, and when |
