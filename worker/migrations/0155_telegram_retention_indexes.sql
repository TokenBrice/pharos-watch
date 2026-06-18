-- rollout-safety: backward-compatible
-- Add indexes used by Telegram inactive subscriber scans and capped retention
-- cleanup batches. These are additive and safe for the current production
-- Worker while the migration applies before deploy.

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_last_active_at
  ON telegram_subscribers(last_active_at);

CREATE INDEX IF NOT EXISTS idx_taj_created_at
  ON telegram_alert_jobs(created_at);

CREATE INDEX IF NOT EXISTS idx_tajt_created_at
  ON telegram_alert_job_targets(created_at);
