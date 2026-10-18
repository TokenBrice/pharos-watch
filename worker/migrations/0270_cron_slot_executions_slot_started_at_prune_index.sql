-- rollout-safety: backward-compatible
-- Retention uses the logical slot clock; 0259 indexes the actual start clock.
CREATE INDEX IF NOT EXISTS idx_cron_slot_executions_slot_started_at_prune
  ON cron_slot_executions(slot_started_at);
