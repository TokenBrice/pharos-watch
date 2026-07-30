-- rollout-safety: backward-compatible
-- Add nullable idempotency keys for retry-safe status append-only rows.

ALTER TABLE status_transitions ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_status_transitions_idempotency_key
  ON status_transitions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE status_probe_runs ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_status_probe_runs_idempotency_key
  ON status_probe_runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
