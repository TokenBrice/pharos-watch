-- rollout-safety: backward-compatible
-- Apply before both Workers activate. Legacy slots remain NULL; no backfill.
ALTER TABLE cron_slot_executions ADD COLUMN child_marker_version INTEGER;

CREATE TABLE scheduled_child_attempts (
  attempt_key TEXT PRIMARY KEY,
  schedule_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  job TEXT NOT NULL,
  producer_path TEXT NOT NULL,
  producer_kind TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  execution_schedule_key TEXT NOT NULL,
  execution_slot_started_at INTEGER NOT NULL,
  execution_invocation_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL,
  execution_owner TEXT NOT NULL,
  worker_version TEXT,
  started_at INTEGER,
  lease_owner TEXT,
  terminal_source TEXT CHECK (terminal_source IN ('real', 'preflight', 'synthetic')),
  terminal_token TEXT,
  terminal_at INTEGER,
  FOREIGN KEY (execution_schedule_key, execution_slot_started_at)
    REFERENCES cron_slot_executions (slot_key, slot_started_at) ON DELETE CASCADE
);
CREATE INDEX idx_scheduled_child_attempts_execution
  ON scheduled_child_attempts (execution_schedule_key, execution_slot_started_at, execution_generation);
