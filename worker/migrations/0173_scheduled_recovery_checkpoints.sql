-- rollout-safety: backward-compatible
-- Persist generation-fenced scheduled-job checkpoints so a later invocation
-- can distinguish platform abandonment from an adapter failure and resume
-- replay-safe work under a new attempt identity.

CREATE TABLE IF NOT EXISTS worker_scheduled_checkpoints (
  schedule_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  job TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  execution_generation INTEGER NOT NULL DEFAULT 1,
  invocation_id TEXT NOT NULL,
  worker_version TEXT,
  queue_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'running',
      'ready',
      'recovering',
      'completed',
      'failed',
      'platform_abandoned'
    )
  ),
  next_item_key TEXT,
  current_item_key TEXT,
  current_domain_attempt_id TEXT,
  items_done INTEGER NOT NULL DEFAULT 0,
  items_total INTEGER NOT NULL DEFAULT 0,
  child_dispositions_json TEXT NOT NULL DEFAULT '{}',
  recovery_owner TEXT,
  recovery_lease_until INTEGER,
  source_attempt_no INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (schedule_key, slot_started_at, job, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_worker_scheduled_checkpoints_recovery_ready
  ON worker_scheduled_checkpoints(state, recovery_lease_until, updated_at)
  WHERE state IN ('ready', 'recovering');

CREATE INDEX IF NOT EXISTS idx_worker_scheduled_checkpoints_slot
  ON worker_scheduled_checkpoints(schedule_key, slot_started_at, job, attempt_no DESC);

CREATE INDEX IF NOT EXISTS idx_worker_scheduled_checkpoints_job_updated
  ON worker_scheduled_checkpoints(job, updated_at DESC);
