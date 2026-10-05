# Free-tier limits: structure, granularity, precision

What each free tier actually limits, what it tells you about the remaining
allowance, and how precise that information is. Collected 2026-10-03 from the
D1 trace (`ladder_calls.attempts`), the OpenRouter key endpoint, live zen probes
through the relay IP, and opencode.ai/docs. The zen section was rewritten the same
day from a dedicated limit-triggering study (`scripts/zen-limit-probe.mjs`, issue #106)
run from five runtimes: local Mac, GCP VM, Cloudflare Worker, GitHub Actions (×4
runs), and an attempted Google Cloud Function.

---

## Summary

| Tier | What the limit counts | Granularity | Remaining visible? | Precision |
|---|---|---|---|---|
| **OpenRouter `:free`** | requests per **day** (1000) + requests per **minute** (20), **account-wide** | day / minute | **yes** — `GET /api/v1/key` → `free_model_daily_requests` | exact (integer + exact reset timestamp) |
| **Zen free** (`*-free` via relay) | **requests**, per IP **per model**: a rate limit ~90–95/min + a daily quota ~940/day | minute / day | **no** — body carries no numbers | rate limit: none; daily quota: exact to the second (`retry-after` → 00:00 UTC) |
| **Go `*-free`** (`opencode-go/*-free`) | nothing — Unlimited per docs, never consumes the $-allowance | n/a | n/a | n/a |
| Go paid (contrast) | **USD per model per month**, windows 5h 20% / week 50% / month 100% | 5h / week / month | no — console only | n/a |

---

## OpenRouter `:free` — two limits, both account-wide

The eight `:free` rungs we use (nemotron-3-super / -ultra / -nano-omni,
ling-3.0-flash-sante, north-mini-code, dots-3-note, laguna-xs) share **one**
counter. During the 2026-10-02 storm all of them flipped to 429 at the same
instant with an identical `Remaining: 0` — proof the counter is not per model.

### 1. Daily — `free-models-per-day-high-balance`

```
HTTP 429
"message": "Rate limit exceeded: free-models-per-day-high-balance. "
"metadata": {
  "headers": {"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": "1790985600000"},
  "limit_source": "openrouter_free_tier_daily",
  "remedy_hint": "Wait for the daily reset (see X-RateLimit-Reset)"
}
```

- **1000 requests per day**, resets at **00:00 UTC** (`1790985600000` =
  2026-10-03T00:00:00Z).
- The only tier in the stack that exposes a **live remaining counter**:
  ```
  curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
  → "free_model_daily_requests": {"used": 1060, "limit": 1000, "remaining": 0}
  ```
  Note `used` can exceed `limit` — rejected attempts count into it.
- Granularity: 1 request. Precision: exact.

### 2. Per-minute — `free-models-per-min`

```
"message": "Rate limit exceeded: free-models-per-min. "
"X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "0",
"limit_source": "openrouter_free_tier_per_minute",
"remedy_hint": "Slow down requests to free models, or retry after ..."
```

- **20 requests per minute**, sliding minute window (`X-RateLimit-Reset` = the
  next minute boundary). This is what a tight loop hits first; the daily limit is
  what a long run hits second.

### What the storm cost us

Storm window 13:46–19:50 UTC on 2026-10-02 → `used: 1060 / limit: 1000`, i.e.
the daily budget was gone by ~19:00 UTC and stayed 429 for everyone until
midnight. The ladder then walked Go-free rungs → OR `:free` → zen, and once
those were all exhausted it fell through to the paid tail (520 paid calls in the
hour after the incident).

---

## Zen free — three limit layers, per (IP, model), all request-based

Zen free models (`space-bunny-free`, `longcat-2.5-preview-free`,
`mimo-v2.6-flash-free`, `mimo-v2.5-free`, `big-pickle`,
`nemotron-3.5-lightning-free`) are **anonymous** — `Authorization: Bearer public`
is a placeholder, and dropping the header entirely still returns 200. The gate is
double: an opencode-client **fingerprint** (client) and an **IP budget** (network).
Both were mapped live on 2026-10-03 with `scripts/zen-limit-probe.mjs` (issue #106).

### The fingerprint — 4 required fields, 4 cosmetic

| field | required | evidence (all live) |
|---|---|---|
| `user-agent` starting with `opencode/` | **yes** | `curl/8.7.1` → 403; `opencode/9.99.99` → 200 — the version is **not** pinned |
| `x-opencode-session: ses_<12 hex><14 alnum>` | **yes** | absent → 403; `hello` / `ses_wrong` → 403 — the **shape** is validated, the value is free and reusable (same id ×3 → 200) |
| `stream: true` | **yes** | `stream:false` → 403 |
| `tools` containing both `shell` and `read` | **yes** | neither → 403; only `shell` → 403; only `read` → 403; wrong JSON schema → 200 — **names only**, order free |
| `authorization` | no | header dropped → 200 |
| `x-opencode-client: cli` | no | dropped → 200 |
| `x-opencode-project: global` | no | dropped → 200 |
| `x-opencode-request: msg_…` | no | dropped → 200 |

A rejected fingerprint is **403 `FreeTierError`** ("OpenCode's free tier can only be
used from within OpenCode") — a different error type from the 429 rate limit, so a
caller can tell "wrong client" from "no quota" without parsing bodies.

### Three limits, metered against the IP separately per model

**1. Provider rate limit — burst protection (bare 429, no headers).**

```
HTTP 429
{"type":"error","error":{"type":"FreeUsageLimitError",
  "message":"Error from provider (Console): Rate limit exceeded. Please try again later."}}
```

The `(Console)` prefix marks it as coming from the **model provider behind zen**, not
from zen's own quota. It carries **no `retry-after` and no other header**. Trips at
sustained **~90–95 requests/min per IP per model** (a GH runner peaking at 96/min tripped at 894
total; one peaking at 79/min did not). A slow fire at ~41/min is unaffected.

**2. Provider daily budget — the same bare 429, no headers.**

Same body as above. Trips at **~915–965 requests per IP per model per day** regardless of rate
(a slow 42/min run tripped at 915 and 964). A residential IP that tripped it stayed
blocked **>100 min** (1 probe / 90 s never cleared it) — consistent with a daily reset.

**3. Zen free daily quota — 429 with an exact wake-up time.**

```
retry-after: 26967   →  26824   (counts down in real time)
{"type":"error","error":{"type":"FreeUsageLimitError",
  "message":"Rate limit exceeded. Please try again later."},"metadata":{}}
```

`retry-after` lands exactly on **00:00 UTC** (16:30 + 26967 s = 23:59:57) — a **daily
quota per IP per model**, resetting at midnight UTC. Measured at **~940 requests per IP per day**
on the relay VM (942 fired → dark). This is the layer the 2026-10-02 storm hit.

Limits 2 and 3 are nearly the same size (~940/day) and both reset at midnight — most
likely **one daily quota enforced at two layers**, which is why the same over-limit
request can come back with either 429 shape depending on which layer rejects first.
The ladder cannot tell them apart by count, only by body/headers.

### Unit: requests, not tokens

100 requests × 2048 output tokens = **219,800 tokens with zero 429s** (two parallel GH
runners), while a 142-token "ping" burst tripped the rate limit at ~126K tokens / ~890
requests. Every layer counts **requests**, not tokens.

### Context cap — a fourth limit, per model

Separate from the request counters, each model has a **context cap**, and it is **per model**
(not per tier, not per IP). Measured live with `scripts/zen-limit-probe.mjs --fill-tokens`
(send ~N tokens, read the server's own cap from the 400):

| model (zen free) | cap, tokens | stability |
|---|---|---|
| `mimo-v2.6-flash-free` | 1,048,576 | stable |
| `mimo-v2.5-free` | 1,048,576 | stable |
| `nemotron-3.5-lightning-free` | 1,000,000 | stable |
| `big-pickle` | **262,139** | unstable — backends with 262,139 and ≥1M, non-deterministic |

**When a model is non-deterministic, use the minimum** (`big-pickle` → 262,139): the maximum
is luck, not a guarantee. Caps are not in any docs — zen `/v1/models` returns no
`context_length` — so each new model is measured. The client follows this before sending
(`prompt + max_tokens ≤ cap`); see `docs/github-actions-zen-client-spec.md` §4.

### Runtime × limit (2026-10-03)

| runtime | egress | outcome | stopped at | 429 carries |
|---|---|---|---|---|
| local Mac (residential) | home IP | 200 | after 463–470 requests | nothing (provider) |
| GCP VM `alesa-vm` (relay, #36) | 136.65.7.197 | 200 | after 942 requests | 15 bare, then `retry-after` → midnight UTC |
| Cloudflare Worker | CF shared egress (colo ARN/SE) | **429 from request #1** | immediately | `retry-after` → midnight UTC |
| GitHub Actions (fast, 96/min peak) | Azure IP ×2 parallel | 200 | 894 / 884 requests | nothing (provider rate limit) |
| GitHub Actions (slow, ~41/min) | Azure IP ×2 | 200 | 900/900, not reached | — |
| GitHub Actions (slow, 1200 fired) | Azure IP ×2 | 200 | 964 (zen daily) / 915 (provider) | `retry-after` → midnight / nothing |
| Google Cloud Function | — | not measured — deploy blocked by project IAM (build SA) | | |

**The limit is per (IP, model), not per fingerprint**: a blocked residential IP stayed 429 with
a *different* `user-agent` too. Two parallel GH runners each got their own budget —
**no intersection**, confirming the owner's hypothesis (#95).

**Per model, not one shared counter.** On the same relay IP, in one bench run, `mimo-v2.6`,
`mimo-v2.5` and `big-pickle` all returned 429 while `nemotron-3.5-lightning` kept answering —
so tripping one model does not silence another. The IP is the identity the provider meters
against; the budget itself is per model (provider). Track state per model, not globally.

### Our own budget numbers (what the code enforces)

Two layers, both **per model**, because the quota above is per model:

| Layer | Where | Rate | Day |
|---|---|---|---|
| Controller | `src/zen-runner.js` `LIMITS`, row `zen_budget(repo, model)` | 50/min per (repo, model) | **700/day per (repo, model)** |
| Worker | `scripts/zen-client.mjs` `dailyBudget` (`ZEN_DAILY_BUDGET`) | 50/min per model, in-process | **700/day per model**, counters in memory, reset with the run |

700 sits under both measured ceilings — ~940/day for zen free per (IP, model) and 1000/day for
OpenRouter `:free` per account — and it is deliberately NOT 1000: the counters must trip before the
provider does, so a mistake shows up as our own 429 with a `retry_after`, not as a provider storm.

The shared `('*','*')` row is a runaway brake, not an allowance: its day cap is
`perDay × (per-model counters that moved today + 1)`, so it can never be tighter than the sum of
the independent per-provider quotas, and a provider that has not called yet is never refused by
another's spending (issue #24). Its **minute** cap stays shared on purpose — an account-wide rate
limit is real (OpenRouter `:free` = 20/min per account).

### What this means for the ladder

- **CF Worker egress is unusable for zen** — 429 from request #1 on every colo. The
  relay on the GCP VM is not a workaround, it is the only way.
- **The relay IP has a daily budget of ~940 requests.** Once exhausted, zen is dark
  until 00:00 UTC. Spread zen load across egress IPs (or accept the ceiling).
- **The rate limit (~90–95/min) only matters for bursts.** Normal ladder traffic is a
  few zen calls per minute — far below it. Do not let a retry loop or a parallel fan-out
  exceed ~90 req/min on one egress IP.
- **A bare 429 (no `retry-after`) means "back off for a long, unknown cooldown"** —
  do not feed it into the health-skip TTL as if it were a precise wake-up time. Only
  the `retry-after` shape is safe for that.

---

## Go `*-free` — unlimited allowance, but still needs a valid key

`opencode-go/space-bunny-free` and `opencode-go/longcat-2.5-preview-free` are
listed in the Go docs as **Free / Unlimited (limited time)**. They never consume
the model's $-allowance, which is why the ladder keeps serving them while every
paid Go rung is parked during a limit incident (#69). The key carousel (#81)
only spreads load across accounts — there is no allowance to protect.

**But "unlimited" is about the allowance, not about auth.** A `*-free` rung still
sends a pooled key, so it dies with the key: `401 AuthError: Invalid API key`
kills free and paid Go rungs alike. Revoking a key "to save the last percent of
the limit" therefore backfires — the paid allowance is already spent, free models
don't touch it, and revoking only removes the one free option that was still
serving.

For the paid Go rungs the structure is completely different: USD per model per
month, windows 5h 20% / week 50% / month 100%, shared per workspace
(`workspace: wrk_…` in the error). Details in issue #84.

## The cascade that pushed traffic onto the paid OpenRouter tail (2026-10-02)

Reproduced from the D1 trace — the sequence matters, each step alone is survivable:

1. **17:52** — paid Go weekly allowance hit (`GoUsageLimitError` on
   `deepseek-v4-flash`) → paid Go rungs parked.
2. **17:52–19:23** — **free Go rungs kept serving** (484 successful in the 18:00
   hour). This is #69 working: the paid limit does *not* kill `*-free`.
3. **19:23 — the key was revoked** → every Go rung, free included, began returning
   `401 AuthError: Invalid API key` (2490 calls until 22:10).
4. OR `:free` was already at `used: 1060 / limit: 1000` (429) and zen was 429.
5. → the **paid OpenRouter tail** took the load: `build` 803, `service`/`deepseek`
   561, `research:explore` 15 successful paid calls in the window.

**mcp-eval itself never reached paid OpenRouter.** It ran on the `free` ladder
(now folded into `free`), which has no paid tail; it burned the *paid Go* allowance because
the `free` ladder's head rung was `opencode-go/deepseek-v4-flash` — the naming
bug fixed in #79. The paid OpenRouter traffic came from the *other* ladders
(`build`, `service`, …), which do have paid tails, once step 3 removed their last
free Go rung.

---

## Practical consequences

1. **The daily OR counter is the only thing worth watching proactively** —
   poll `/api/v1/key` (one request) and trip an alert at e.g. 800/1000.
2. **A loop can burn the whole daily budget in minutes** — 20/min is the only
   brake, and it is per minute, not per hour. Any caller that must not pay money
   belongs on the `free` ladder (#79), never on a ladder with a paid tail.
3. **Zen 429s come in two shapes — read the body, not just the status.** A bare 429
   ("Error from provider (Console)", no headers) is the provider rate limit: no
   `retry-after`, unknown cooldown, back off for a long time. A 429 with
   `retry-after` is the daily quota: the header counts down to 00:00 UTC exactly.
   Only the second shape is safe to feed into the ladder's health-skip TTL.
4. **When all three free tiers are exhausted, the paid tail is what takes the
   load.** That is by design (reliability beats price), but it makes the paid
   spend a function of how long the free tiers stay dark.
5. **Never revoke a Go key to "save allowance" mid-incident.** Free Go rungs are
   the fallback that survives a paid-limit hit; revoking the key takes them down
   too and routes the fleet straight to the paid OpenRouter tail. The allowance
   is not saved — free models never consumed it.
---

## Calling zen free from a job (not measuring it)

The limits above are what `scripts/zen-limit-probe.mjs` measures by firing **unguarded**
requests. A job that merely wants an answer should not do that — it should use
`scripts/zen-client.mjs`, which keeps every counter per model and reports which limit stopped it:

```js
import { createZenClient } from './zen-client.mjs';
const zen = createZenClient({ ratePerMin: 80, dailyBudget: 800 });
const r = await zen.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'ping' }] });
if (!r.ok && r.kind === 'cooldown') break;              // a limit, not a failure
if (!r.ok && r.kind === 'fingerprint') process.exit(1); // our headers regressed — loud
console.log(zen.summary());                            // stoppedBy / cooldownUntil per model
```

The test build that proves it from a real runner is `.github/workflows/zen-selftest.yml`
(`workflow_dispatch`, or every 6h): one signed call per free model, a `stream:false` → 403 negative
test, an offline over-cap refusal, and a report where a limited cell is ⛔ "not measured" and is
excluded from the denominator. Spec: `docs/github-actions-zen-client-spec.md`.
