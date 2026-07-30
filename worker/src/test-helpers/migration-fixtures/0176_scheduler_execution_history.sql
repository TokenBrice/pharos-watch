-- rollout-safety: backward-compatible
-- 0176: Attribute scheduled work to an executable path/version and retain
-- invocation, productive-output, publication, and budget-only history.

ALTER TABLE cron_runs ADD COLUMN schedule_key TEXT;
ALTER TABLE cron_runs ADD COLUMN producer_path TEXT;
ALTER TABLE cron_runs ADD COLUMN producer_kind TEXT;
ALTER TABLE cron_runs ADD COLUMN invocation_id TEXT;
ALTER TABLE cron_runs ADD COLUMN worker_version TEXT;
ALTER TABLE cron_runs ADD COLUMN productive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cron_runs ADD COLUMN publication_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cron_runs ADD COLUMN calendar_period TEXT;

ALTER TABLE cron_slot_executions ADD COLUMN invocation_id TEXT;
ALTER TABLE cron_slot_executions ADD COLUMN worker_version TEXT;

CREATE INDEX IF NOT EXISTS idx_cron_runs_schedule_path_started
  ON cron_runs(schedule_key, producer_path, job, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_invocation
  ON cron_runs(invocation_id)
  WHERE invocation_id IS NOT NULL;

ALTER TABLE worker_job_attempts ADD COLUMN producer_path TEXT;
ALTER TABLE worker_job_attempts ADD COLUMN invocation_id TEXT;
ALTER TABLE worker_job_attempts ADD COLUMN worker_version TEXT;

CREATE INDEX IF NOT EXISTS idx_worker_job_attempts_schedule_path_updated
  ON worker_job_attempts(schedule_key, producer_path, job, updated_at DESC);

ALTER TABLE worker_canary_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'shadow';

CREATE INDEX IF NOT EXISTS idx_worker_canary_runs_mode_check_observed
  ON worker_canary_runs(mode, check_id, observed_at DESC);

ALTER TABLE surface_publication_generations ADD COLUMN producer_schedule_key TEXT;
ALTER TABLE surface_publication_generations ADD COLUMN producer_job TEXT;
ALTER TABLE surface_publication_generations ADD COLUMN producer_path TEXT;
ALTER TABLE surface_publication_generations ADD COLUMN producer_kind TEXT;
ALTER TABLE surface_publication_generations ADD COLUMN invocation_id TEXT;
ALTER TABLE surface_publication_generations ADD COLUMN worker_version TEXT;

CREATE TABLE IF NOT EXISTS worker_producer_history (
  idempotency_key TEXT PRIMARY KEY,
  schedule_key TEXT NOT NULL,
  job TEXT NOT NULL,
  producer_path TEXT NOT NULL,
  producer_kind TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  worker_version TEXT,
  slot_started_at INTEGER,
  invoked_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('ok', 'degraded', 'error', 'skipped_locked', 'skipped_neutral', 'not_started', 'abandoned')
  ),
  productive INTEGER NOT NULL DEFAULT 0 CHECK (productive IN (0, 1)),
  item_count INTEGER,
  publication_count INTEGER NOT NULL DEFAULT 0,
  publications_json TEXT,
  calendar_period TEXT,
  metadata_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(schedule_key, job, producer_path, producer_kind, invocation_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_producer_history_identity_invoked
  ON worker_producer_history(schedule_key, job, producer_path, producer_kind, invoked_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_producer_history_productive
  ON worker_producer_history(schedule_key, job, producer_path, producer_kind, productive, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_producer_history_kind_completed
  ON worker_producer_history(producer_kind, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_producer_history_calendar_period
  ON worker_producer_history(calendar_period, completed_at DESC)
  WHERE calendar_period IS NOT NULL;

CREATE TABLE IF NOT EXISTS worker_producer_heads (
  schedule_key TEXT NOT NULL,
  job TEXT NOT NULL,
  producer_path TEXT NOT NULL,
  producer_kind TEXT NOT NULL,
  last_invocation_id TEXT NOT NULL,
  last_worker_version TEXT,
  last_invoked_at INTEGER NOT NULL,
  last_completed_at INTEGER NOT NULL,
  last_outcome TEXT NOT NULL,
  last_error TEXT,
  last_productive_invocation_id TEXT,
  last_productive_at INTEGER,
  last_productive_item_count INTEGER,
  last_publication_at INTEGER,
  last_publications_json TEXT,
  invocation_count INTEGER NOT NULL DEFAULT 0,
  productive_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (schedule_key, job, producer_path, producer_kind)
);

CREATE INDEX IF NOT EXISTS idx_worker_producer_heads_job
  ON worker_producer_heads(job, producer_kind, last_completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_producer_heads_productive
  ON worker_producer_heads(producer_kind, last_productive_at DESC);

CREATE TABLE IF NOT EXISTS detail_cache_write_generations (
  stablecoin_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  claim_owner TEXT NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  published_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_detail_cache_write_generations_updated
  ON detail_cache_write_generations(updated_at DESC);
