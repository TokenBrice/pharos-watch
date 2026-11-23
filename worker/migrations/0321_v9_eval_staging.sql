-- rollout-safety: backward-compatible
-- Additive Safety Score V9 chunked-evaluation staging and heavy Queue delivery
-- ledger (ADR-26 Release 1). Inert while heavy WORKER_V9_QUEUE_MODE = "off";
-- Queue producer/consumer bindings are added separately in Release 2 after
-- operator queue provisioning. Queue deliveries never create cron_slot_executions
-- or scheduler-delivery evidence.

CREATE TABLE IF NOT EXISTS v9_eval_runs (
  run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  schedule_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  clock_sec INTEGER NOT NULL,
  source_generation TEXT NOT NULL,
  base_input_generation_id TEXT NOT NULL,
  registry_fingerprint TEXT NOT NULL,
  evaluation_build_digest TEXT NOT NULL,
  worker_version TEXT,
  accepted_baseline_generation_id TEXT,
  accepted_baseline_sha256 TEXT,
  dex_generation_id TEXT,
  redemption_generation_id TEXT,
  fact_set_digest TEXT,
  plan_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  quarantine_epoch INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_epoch >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1),
  next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_index >= 0),
  materialize_step_count INTEGER NOT NULL DEFAULT 0 CHECK (materialize_step_count >= 0),
  next_materialize_step INTEGER NOT NULL DEFAULT 0 CHECK (next_materialize_step >= 0),
  stage TEXT NOT NULL CHECK (stage IN ('seeded', 'evaluating', 'committing', 'materializing', 'completed', 'failed', 'superseded')),
  state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'failed', 'superseded')),
  execution_generation INTEGER NOT NULL DEFAULT 1 CHECK (execution_generation >= 1),
  execution_owner TEXT NOT NULL,
  publication_generation_id TEXT,
  payload_sha256 TEXT,
  superseded_by_run_id TEXT,
  failure_reason TEXT,
  plan_metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_v9_eval_runs_state_updated
  ON v9_eval_runs (state, updated_at);
CREATE INDEX IF NOT EXISTS idx_v9_eval_runs_slot
  ON v9_eval_runs (schedule_key, slot_started_at, created_at DESC, run_id DESC);
CREATE INDEX IF NOT EXISTS idx_v9_eval_runs_retention
  ON v9_eval_runs (finished_at);

-- Bounded per-run staging blobs (<=512 KiB per row). Pruned on select/supersession,
-- >1h sweep at Seed/:52, and ON DELETE CASCADE from v9_eval_runs.
CREATE TABLE IF NOT EXISTS v9_eval_chunks (
  run_id TEXT NOT NULL REFERENCES v9_eval_runs(run_id) ON DELETE CASCADE,
  chunk_kind TEXT NOT NULL CHECK (chunk_kind IN ('run_context', 'fact_shard', 'upstream_state', 'card_shard', 'chunk_summary', 'materialize_header')),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  part_index INTEGER NOT NULL DEFAULT 0 CHECK (part_index >= 0),
  quarantine_epoch INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_epoch >= 0),
  encoding TEXT NOT NULL CHECK (encoding IN ('json', 'deflate-base64', 'gzip-base64')),
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) BETWEEN 1 AND 524288),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 524288),
  payload_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, chunk_kind, chunk_index, part_index)
);
CREATE INDEX IF NOT EXISTS idx_v9_eval_chunks_created_at
  ON v9_eval_chunks (created_at);

-- Dedicated heavy Queue delivery ledger; never authorizes execution on its own.
CREATE TABLE IF NOT EXISTS v9_eval_queue_executions (
  delivery_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES v9_eval_runs(run_id) ON DELETE CASCADE,
  schedule_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('eval', 'commit', 'materialize')),
  chunk_index INTEGER CHECK (chunk_index IS NULL OR chunk_index >= 0),
  quarantine_epoch INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_epoch >= 0),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  source_invocation_id TEXT NOT NULL,
  execution_owner TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation >= 1),
  invocation_id TEXT NOT NULL,
  worker_version TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'reconciling', 'finished')),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  finished_at INTEGER,
  result_status TEXT,
  failure_reason TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_v9_eval_queue_executions_recovery
  ON v9_eval_queue_executions (state, updated_at);
CREATE INDEX IF NOT EXISTS idx_v9_eval_queue_executions_retention
  ON v9_eval_queue_executions (finished_at);
CREATE INDEX IF NOT EXISTS idx_v9_eval_queue_executions_run
  ON v9_eval_queue_executions (run_id, started_at DESC, delivery_id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v9_eval_queue_executions_invocation
  ON v9_eval_queue_executions (invocation_id);
