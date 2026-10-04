-- Zen Pool — a long-lived GitHub Actions job turned into a request/response service.
--
-- The problem this solves: a GitHub-hosted runner has NO inbound address (measured: nothing is
-- handed back at dispatch, see zen-runner notes), so "dispatch a run per answer" costs a whole
-- cold start (~10-13 s measured) for every single call. Instead ONE job boots, registers here,
-- and then holds a long-poll open; the caller POSTs a task and the answer comes back inside the
-- same HTTP request — no new job, no new boot.
--
-- Applied by ci.yml on every deploy (idempotent: IF NOT EXISTS everywhere). Same database as the
-- zen-runner control plane on purpose: one set of counters, one place where the limits live.

-- One row per live runner job. The lease is the liveness signal: every pull renews it, so a job
-- that died without saying goodbye simply stops being renewed and drops out of the pool.
CREATE TABLE IF NOT EXISTS zen_pool_workers (
  id TEXT PRIMARY KEY,                           -- lease_id handed to the job
  worker_id TEXT NOT NULL,                       -- stable id of the job (repo:run:attempt)
  repo TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  run_attempt TEXT NOT NULL DEFAULT '',
  egress_ip TEXT,
  runner_name TEXT,
  node TEXT,
  state TEXT NOT NULL DEFAULT 'live',            -- live | stopping | gone
  tasks_served INTEGER NOT NULL DEFAULT 0,
  idle_exit_ms INTEGER NOT NULL DEFAULT 600000,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  registered_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  exited_at INTEGER
);
CREATE INDEX IF NOT EXISTS zen_pool_workers_live ON zen_pool_workers(state, lease_expires_at);

-- One row per task. state: queued -> claimed -> done | failed | expired.
-- `expired` means the CALLER's watchdog fired before the answer arrived — the job keeps working
-- and the answer still lands in this row, readable at GET /zen/pool/result/{id}.
CREATE TABLE IF NOT EXISTS zen_pool_tasks (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  max_tokens INTEGER NOT NULL DEFAULT 300,
  wait_ms INTEGER NOT NULL DEFAULT 30000,        -- the caller's watchdog, echoed back
  state TEXT NOT NULL DEFAULT 'queued',
  worker_id TEXT,
  lease_id TEXT,
  text TEXT,
  kind TEXT,
  error TEXT,
  ok INTEGER,
  provider_ms INTEGER,
  served_ms INTEGER,
  enqueued_at INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  finished_at INTEGER,
  wait_returned_at INTEGER
);
CREATE INDEX IF NOT EXISTS zen_pool_tasks_queued ON zen_pool_tasks(state, enqueued_at);
CREATE INDEX IF NOT EXISTS zen_pool_tasks_worker ON zen_pool_tasks(worker_id, claimed_at);