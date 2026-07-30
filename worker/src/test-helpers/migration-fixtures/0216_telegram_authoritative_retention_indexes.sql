-- rollout-safety: backward-compatible
-- Support terminal-source retention scans and the existing job-target item
-- audit cleanup without full scans of the high-volume Telegram ledgers.

CREATE INDEX IF NOT EXISTS idx_tase_terminal_completed
  ON telegram_alert_source_events(completed_at, source_event_id)
  WHERE status IN ('complete', 'expired');

CREATE INDEX IF NOT EXISTS idx_tajti_created_at
  ON telegram_alert_job_target_items(created_at);
