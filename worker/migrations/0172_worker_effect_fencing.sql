-- rollout-safety: backward-compatible
-- Fence scheduled/admin/Telegram effects and make retried cron telemetry inserts idempotent.

ALTER TABLE cron_slot_executions
  ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE cron_runs
  ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_idempotency_key
  ON cron_runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE admin_idempotency_keys
  ADD COLUMN reservation_owner TEXT;

ALTER TABLE admin_idempotency_keys
  ADD COLUMN reservation_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE admin_idempotency_keys
  ADD COLUMN execution_started_at INTEGER;

ALTER TABLE telegram_pending_alerts
  ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE telegram_pending_alerts
  ADD COLUMN delivery_started_at INTEGER;

ALTER TABLE telegram_pending_alerts
  ADD COLUMN delivery_completed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tpa_delivery_claim_ready
  ON telegram_pending_alerts(delivery_state, processing_expires_at, priority, not_before_at, created_at);

ALTER TABLE telegram_processed_updates
  ADD COLUMN effect_state TEXT NOT NULL DEFAULT 'unstarted';

ALTER TABLE telegram_processed_updates
  ADD COLUMN effect_key TEXT;

ALTER TABLE telegram_processed_updates
  ADD COLUMN effect_started_at INTEGER;

ALTER TABLE telegram_processed_updates
  ADD COLUMN claim_owner TEXT;

ALTER TABLE telegram_processed_updates
  ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_processed_updates_effect_key
  ON telegram_processed_updates(effect_key)
  WHERE effect_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_date_page
  ON blacklist_events(timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_stablecoin_page
  ON blacklist_events(stablecoin, timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_chain_page
  ON blacklist_events(chain_name, timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_event_page
  ON blacklist_events(event_type, timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;
