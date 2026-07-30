-- rollout-safety: backward-compatible
-- 0157: Partial index on telegram_subscribers.global_alert_reserve so the
-- dispatcher can enumerate reserve-drift global subscribers without scanning
-- the full telegram_subscribers table (mirrors 0117 for the new family).

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_reserve
  ON telegram_subscribers (chat_id) WHERE global_alert_reserve = 1;
