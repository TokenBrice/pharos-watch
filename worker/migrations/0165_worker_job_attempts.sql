-- rollout-safety: backward-compatible
-- 0165: Add a shadowable per-job attempt ledger for scheduled Worker jobs.
-- The table is intentionally independent from cron_runs so operators can
-- inspect active, deferred, abandoned, and skipped attempts without changing
-- the existing terminal cron history contract.

CREATE TABLE IF NOT EXISTS worker_job_attempts (
  attempt_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  schedule_key TEXT NOT NULL,
  job TEXT NOT NULL,
  slot_started_at INTEGER,
  producer_kind TEXT NOT NULL DEFAULT 'scheduled-slot',
  state TEXT NOT NULL CHECK (
    state IN (
      'queued',
      'claimed',
      'running',
      'completed',
      'deferred',
      'abandoned',
      'failed',
      'skipped_locked',
      'cancelled'
    )
  ),
  status_class TEXT CHECK (
    status_class IS NULL OR status_class IN (
      'ok',
      'degraded',
      'controlled_error',
      'thrown_error',
      'abandoned',
      'deferred',
      'skipped_duplicate',
      'skipped_running',
      'skipped_locked'
    )
  ),
  attempt_no INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  lease_until INTEGER,
  queued_at INTEGER NOT NULL,
  claimed_at INTEGER,
  started_at INTEGER,
  last_heartbeat_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  item_count INTEGER,
  dependency_snapshot_json TEXT,
  cursor_json TEXT,
  result_metadata_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(schedule_key, slot_started_at, job, producer_kind, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_job_queued
  ON worker_job_attempts(job, queued_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_job_updated
  ON worker_job_attempts(job, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_job_updated_queued
  ON worker_job_attempts(job, updated_at DESC, queued_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_slot
  ON worker_job_attempts(schedule_key, slot_started_at);

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_slot_job
  ON worker_job_attempts(schedule_key, slot_started_at, job);

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_state_queued
  ON worker_job_attempts(state, queued_at);

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_state_lease
  ON worker_job_attempts(state, lease_until);

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_state_updated
  ON worker_job_attempts(state, updated_at);

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_job_state_updated
  ON worker_job_attempts(job, state, updated_at DESC);
