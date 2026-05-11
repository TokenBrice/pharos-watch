-- Persistent Telegram preset follows. Presets are resolved at dispatch/list time
-- so cohort follows such as usd-top25 keep tracking the current market-cap set.
-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS telegram_preset_subscriptions (
  chat_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  alert_dews INTEGER NOT NULL DEFAULT 0,
  alert_depeg INTEGER NOT NULL DEFAULT 0,
  alert_safety INTEGER NOT NULL DEFAULT 0,
  depeg_worsening_bps_step INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, preset_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_preset_subscriptions_preset
  ON telegram_preset_subscriptions(preset_id);
