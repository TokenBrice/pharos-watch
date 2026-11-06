-- rollout-safety: backward-compatible
-- Ordinary retention has no equality constraint on producer_kind.
CREATE INDEX IF NOT EXISTS idx_worker_producer_history_noncalendar_completed
  ON worker_producer_history(completed_at)
  WHERE calendar_period IS NULL;
