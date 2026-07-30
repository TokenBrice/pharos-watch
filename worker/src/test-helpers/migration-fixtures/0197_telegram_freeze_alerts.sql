-- rollout-safety: backward-compatible
-- Opt-in only Telegram alerts for immutable freeze tape events. Existing
-- subscribers remain disabled until they explicitly enable this family.
ALTER TABLE telegram_subscribers ADD COLUMN alert_freeze INTEGER NOT NULL DEFAULT 0 CHECK (alert_freeze IN (0, 1));
ALTER TABLE telegram_subscribers ADD COLUMN global_alert_freeze INTEGER NOT NULL DEFAULT 0 CHECK (global_alert_freeze IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_freeze INTEGER NOT NULL DEFAULT 0 CHECK (alert_freeze IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_freeze_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_freeze_override IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_freeze
  ON telegram_subscribers (chat_id) WHERE global_alert_freeze = 1;

-- Freeze is deliberately isolated from telegram_alert_target_plans: that
-- existing table has a legacy five-family CHECK constraint and cannot be
-- widened through an additive migration. The dedicated source-event/outbox
-- tables retain tape and blacklist identities without weakening that contract.
CREATE TABLE IF NOT EXISTS telegram_freeze_alert_events (
  source_event_id TEXT PRIMARY KEY CHECK (length(source_event_id) BETWEEN 1 AND 200),
  tape_event_id TEXT NOT NULL UNIQUE CHECK (length(tape_event_id) BETWEEN 1 AND 200),
  blacklist_event_id TEXT NOT NULL CHECK (length(blacklist_event_id) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN ('blacklist', 'unblacklist', 'destroy')),
  detected_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 262144),
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'queued', 'complete', 'expired')),
  cohort_captured_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS telegram_freeze_alert_targets (
  source_event_id TEXT NOT NULL,
  target_key TEXT NOT NULL CHECK (length(target_key) BETWEEN 1 AND 200),
  chat_id TEXT NOT NULL,
  preference_generation INTEGER NOT NULL CHECK (preference_generation >= 0),
  pending_dedupe_key TEXT NOT NULL CHECK (length(pending_dedupe_key) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'queued', 'cancelled', 'expired')),
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  cancelled_at INTEGER,
  PRIMARY KEY (source_event_id, target_key),
  FOREIGN KEY (source_event_id) REFERENCES telegram_freeze_alert_events(source_event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_freeze_alert_targets_resume
  ON telegram_freeze_alert_targets(source_event_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_telegram_freeze_alert_targets_page
  ON telegram_freeze_alert_targets(source_event_id, status, target_key);
