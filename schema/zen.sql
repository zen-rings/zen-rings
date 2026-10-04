-- Zen Runner — control plane for free-model self-tests (issue: «эндпоинт для запуска тестов»).
-- Applied by ci.yml on every deploy (idempotent: IF NOT EXISTS everywhere).

-- Availability of one free model, shared across all callers. next_check_at is the "табличка":
-- the client reads it BEFORE calling zen and skips the model until the time comes, so a dead
-- provider is not poked 100 times per run.
CREATE TABLE IF NOT EXISTS zen_models (
  model TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',      -- unknown | ok | flaky | down
  failures INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_kind TEXT,
  last_ok_at INTEGER,
  first_failed_at INTEGER,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS zen_models_due ON zen_models(next_check_at);

-- Counters live in the DB, never in worker memory: a fresh isolate must not reset the budget.
-- Two scopes: (repo, model) — the real quota is per (egress IP, model) and a repo IS an IP —
-- and ('*','*') as a provider-wide brake.
CREATE TABLE IF NOT EXISTS zen_budget (
  scope TEXT NOT NULL,                          -- 'owner/repo' or '*'
  model TEXT NOT NULL,                          -- model id or '*'
  minute_count INTEGER NOT NULL DEFAULT 0,
  minute_at INTEGER NOT NULL DEFAULT 0,
  day_count INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (scope, model)
);

-- Registry of runner repositories. Round-robin across them multiplies the free-tier budget:
-- each repository's Actions run leaves from its own IP. The GitHub token is stored AES-GCM
-- encrypted (ZEN_TOKEN_KEY) — or referenced as env:NAME for a token that already lives in a
-- worker secret and never has to be written down twice.
CREATE TABLE IF NOT EXISTS zen_repos (
  repo TEXT PRIMARY KEY,
  token_enc TEXT,
  token_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  location TEXT NOT NULL DEFAULT '',
  failures INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  last_dispatch_at INTEGER,
  added_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS zen_runs (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  repo TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'dispatched',   -- dispatched | reported
  gh_status INTEGER,
  ok INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  reported_at INTEGER
);
CREATE INDEX IF NOT EXISTS zen_runs_created ON zen_runs(created_at);

-- Ring cursor + free-form knobs (per-minute / per-day caps live here so they can be changed
-- without a deploy).
CREATE TABLE IF NOT EXISTS zen_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);