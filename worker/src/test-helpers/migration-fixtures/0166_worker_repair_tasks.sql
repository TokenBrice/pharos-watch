-- rollout-safety: backward-compatible
-- 0166: Add a generic Worker repair-task ledger for low-priority repair/backfill debt.
-- The first producer is DDR repair-required events. The table is additive and
-- independent from existing cache-backed repair-debt markers during rollout.

CREATE TABLE IF NOT EXISTS worker_repair_tasks (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  state TEXT NOT NULL CHECK (
    state IN (
      'open',
      'claimed',
      'deferred',
      'closed',
      'failed',
      'cancelled'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  locked_by TEXT,
  locked_until INTEGER,
  payload_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_repair_tasks_active_identity
  ON worker_repair_tasks(kind, subject_id)
  WHERE state IN ('open', 'claimed', 'deferred', 'failed');

CREATE INDEX IF NOT EXISTS idx_worker_repair_tasks_claim
  ON worker_repair_tasks(state, next_attempt_at, priority, updated_at)
  WHERE state IN ('open', 'deferred');

CREATE INDEX IF NOT EXISTS idx_worker_repair_tasks_stuck_claim
  ON worker_repair_tasks(locked_until, state)
  WHERE state = 'claimed';

CREATE INDEX IF NOT EXISTS idx_worker_repair_tasks_kind_state_updated
  ON worker_repair_tasks(kind, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_repair_tasks_terminal_updated
  ON worker_repair_tasks(state, updated_at)
  WHERE state IN ('closed', 'cancelled');
