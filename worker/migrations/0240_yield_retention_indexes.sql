-- rollout-safety: backward-compatible
-- Add a recorded_at-leading index for bounded alternatives retention drains.
-- Worker does not run ANALYZE, so production D1 has no sqlite_stat1; this keeps
-- the delete plan deterministic without stats.
CREATE INDEX IF NOT EXISTS idx_yield_source_decision_alternatives_recorded
  ON yield_source_decision_alternatives(recorded_at ASC);
