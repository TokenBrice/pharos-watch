-- rollout-safety: backward-compatible
-- 0117: Hot indexes for the Telegram dispatcher's global-subscriber fan-out
-- queries. Partial indexes on each global_alert_* flag let the dispatcher
-- enumerate eligible chats without scanning the full telegram_subscribers
-- table, and the telegram_pending_alerts(chat_id) index covers the pending
-- drain JOIN.

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_dews
  ON telegram_subscribers (chat_id) WHERE global_alert_dews = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_depeg
  ON telegram_subscribers (chat_id) WHERE global_alert_depeg = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_safety
  ON telegram_subscribers (chat_id) WHERE global_alert_safety = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_launch
  ON telegram_subscribers (chat_id) WHERE global_alert_launch = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_pending_alerts_chat_id
  ON telegram_pending_alerts (chat_id);
