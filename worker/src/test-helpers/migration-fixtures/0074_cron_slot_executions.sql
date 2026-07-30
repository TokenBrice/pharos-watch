-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS cron_slot_executions (
  slot_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  result_status TEXT,
  execution_owner TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  metadata TEXT,
  PRIMARY KEY (slot_key, slot_started_at)
);

CREATE INDEX IF NOT EXISTS idx_cron_slot_executions_state_updated
  ON cron_slot_executions(state, updated_at DESC);

ALTER TABLE cron_runs ADD COLUMN slot_started_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_slot_started
  ON cron_runs(job, slot_started_at DESC);

ALTER TABLE cron_run_progress ADD COLUMN slot_started_at INTEGER;
