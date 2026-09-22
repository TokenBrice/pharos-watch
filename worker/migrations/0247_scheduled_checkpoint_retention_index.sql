-- rollout-safety: backward-compatible
CREATE INDEX IF NOT EXISTS idx_worker_scheduled_checkpoints_terminal_updated
  ON worker_scheduled_checkpoints(updated_at)
  WHERE state IN ('completed', 'failed', 'platform_abandoned');
