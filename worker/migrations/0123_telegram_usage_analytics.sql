-- Privacy-preserving Telegram bot usage aggregates and watcher lifecycle snapshots.
-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS telegram_usage_daily (
  day TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source_category TEXT NOT NULL DEFAULT 'unknown',
  action_detail TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'unknown',
  latency_bucket TEXT NOT NULL DEFAULT 'unknown',
  failure_class TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (
    day,
    event_type,
    source_category,
    action_detail,
    outcome,
    latency_bucket,
    failure_class
  )
);

CREATE INDEX IF NOT EXISTS idx_telegram_usage_daily_day_event
  ON telegram_usage_daily(day, event_type);

CREATE TABLE IF NOT EXISTS telegram_watcher_lifecycle_daily (
  day TEXT PRIMARY KEY,
  snapshot_at INTEGER NOT NULL,
  active_watchers INTEGER NOT NULL DEFAULT 0,
  new_watchers INTEGER NOT NULL DEFAULT 0,
  churned_watchers INTEGER NOT NULL DEFAULT 0,
  reactivated_watchers INTEGER NOT NULL DEFAULT 0,
  explicit_coin_follows INTEGER NOT NULL DEFAULT 0,
  preset_implied_coin_follows INTEGER NOT NULL DEFAULT 0,
  active_preset_followers INTEGER NOT NULL DEFAULT 0,
  active_dews_opt_ins INTEGER NOT NULL DEFAULT 0,
  active_depeg_opt_ins INTEGER NOT NULL DEFAULT 0,
  active_safety_opt_ins INTEGER NOT NULL DEFAULT 0,
  active_launch_opt_ins INTEGER NOT NULL DEFAULT 0,
  quiet_hours_enabled_chats INTEGER NOT NULL DEFAULT 0,
  pending_deliveries INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_telegram_watcher_lifecycle_daily_snapshot_at
  ON telegram_watcher_lifecycle_daily(snapshot_at);

CREATE TABLE IF NOT EXISTS telegram_chat_delivery_diagnostics (
  chat_id TEXT PRIMARY KEY,
  last_successful_delivery_at INTEGER,
  last_successful_reply_at INTEGER,
  last_delivery_attempt_at INTEGER,
  recent_failure_class TEXT,
  updated_at INTEGER NOT NULL
);
