-- rollout-safety: backward-compatible
-- Actual delivery reads use scalar MAX index seeks, not cron completion clocks.
CREATE INDEX IF NOT EXISTS idx_cron_slot_executions_started_at
  ON cron_slot_executions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_slot_executions_slot_started_at
  ON cron_slot_executions(slot_key, started_at DESC);
