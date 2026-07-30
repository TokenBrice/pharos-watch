-- rollout-safety: backward-compatible
-- Add retry/defer metadata for Telegram pending alert delivery.

ALTER TABLE telegram_pending_alerts ADD COLUMN not_before_at INTEGER;
ALTER TABLE telegram_pending_alerts ADD COLUMN last_error_class TEXT;
ALTER TABLE telegram_pending_alerts ADD COLUMN retry_after_sec INTEGER;
ALTER TABLE telegram_pending_alerts ADD COLUMN updated_at INTEGER;
ALTER TABLE telegram_pending_alerts ADD COLUMN dedupe_key TEXT;
ALTER TABLE telegram_pending_alerts ADD COLUMN chunk_index INTEGER;

CREATE INDEX IF NOT EXISTS idx_tpa_ready
  ON telegram_pending_alerts(not_before_at, created_at)
  WHERE not_before_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tpa_not_before
  ON telegram_pending_alerts(not_before_at, created_at)
  WHERE not_before_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tpa_dedupe_key
  ON telegram_pending_alerts(dedupe_key);
