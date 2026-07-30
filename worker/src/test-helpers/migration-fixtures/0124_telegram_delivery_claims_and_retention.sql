-- rollout-safety: backward-compatible
-- Claim metadata for Telegram pending delivery plus indexes used by retention
-- and job-target reconciliation. All columns are nullable so the existing
-- sender can run during the migration window.

ALTER TABLE telegram_pending_alerts ADD COLUMN processing_owner TEXT;
ALTER TABLE telegram_pending_alerts ADD COLUMN processing_started_at INTEGER;
ALTER TABLE telegram_pending_alerts ADD COLUMN processing_expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tpa_claim_ready
  ON telegram_pending_alerts(processing_expires_at, priority, not_before_at, created_at);

CREATE INDEX IF NOT EXISTS idx_tajt_pending_status
  ON telegram_alert_job_targets(pending_dedupe_key, status);

CREATE INDEX IF NOT EXISTS idx_tcd_updated
  ON telegram_chat_delivery_diagnostics(updated_at);
