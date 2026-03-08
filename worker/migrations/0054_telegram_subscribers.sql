CREATE TABLE IF NOT EXISTS telegram_subscribers (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  alert_dews INTEGER NOT NULL DEFAULT 0,
  alert_depeg INTEGER NOT NULL DEFAULT 0,
  alert_safety INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  chat_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_sub_coin ON telegram_subscriptions (stablecoin_id);

CREATE TABLE IF NOT EXISTS telegram_pending_disambiguation (
  chat_id TEXT PRIMARY KEY,
  alert_types TEXT NOT NULL,
  resolved_ids TEXT NOT NULL,
  ambiguous_ticker TEXT NOT NULL,
  candidates TEXT NOT NULL,
  remaining_tickers TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
