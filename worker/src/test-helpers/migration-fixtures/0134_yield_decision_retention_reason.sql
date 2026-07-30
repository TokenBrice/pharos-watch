-- rollout-safety: backward-compatible

ALTER TABLE yield_source_decisions ADD COLUMN retention_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_yield_source_decisions_retention
  ON yield_source_decisions (retention_reason, created_at DESC);
