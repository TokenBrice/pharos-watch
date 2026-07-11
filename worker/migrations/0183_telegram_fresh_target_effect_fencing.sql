-- rollout-safety: backward-compatible
-- Add owner/generation fencing for fresh Telegram alert-target effects. The
-- existing target status remains the delivery outcome; these columns record
-- whether a Bot API effect was started and whether its result is certain.

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN effect_state TEXT NOT NULL DEFAULT 'unstarted'
    CHECK (effect_state IN ('unstarted', 'claimed', 'sending', 'complete', 'execution_unknown'));

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN effect_owner TEXT;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN effect_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN effect_claimed_at INTEGER;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN effect_started_at INTEGER;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN effect_completed_at INTEGER;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN effect_claim_expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tajt_effect_ready
  ON telegram_alert_job_targets(effect_state, effect_claim_expires_at, status, created_at);

CREATE INDEX IF NOT EXISTS idx_tajt_effect_owner
  ON telegram_alert_job_targets(effect_owner, effect_generation)
  WHERE effect_owner IS NOT NULL;
