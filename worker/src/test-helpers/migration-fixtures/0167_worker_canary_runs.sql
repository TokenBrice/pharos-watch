-- rollout-safety: backward-compatible
-- 0167: Add a compact data-invariant canary ledger for scheduled Worker checks.
-- Canary rows are append/upsert telemetry only; they do not alter producer
-- publication state or public API behavior.

CREATE TABLE IF NOT EXISTS worker_canary_runs (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'error', 'skipped')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  observed_at INTEGER NOT NULL,
  duration_ms INTEGER,
  metadata_json TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_worker_canary_runs_check_observed
  ON worker_canary_runs(check_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_canary_runs_status_observed
  ON worker_canary_runs(status, severity, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_canary_runs_observed_at
  ON worker_canary_runs(observed_at DESC);
