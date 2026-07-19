-- rollout-safety: backward-compatible
-- Cover source-specific Telegram candidate-horizon and direct fanout reads for
-- the three high-churn risk families without indexing inactive subscription rows.

CREATE INDEX IF NOT EXISTS idx_tg_sub_dews_coin_chat
  ON telegram_subscriptions(stablecoin_id, alert_snooze_until_ts, chat_id)
  WHERE alert_dews = 1;

CREATE INDEX IF NOT EXISTS idx_tg_sub_depeg_coin_chat
  ON telegram_subscriptions(stablecoin_id, alert_snooze_until_ts, chat_id)
  WHERE alert_depeg = 1;

CREATE INDEX IF NOT EXISTS idx_tg_sub_safety_coin_chat
  ON telegram_subscriptions(stablecoin_id, alert_snooze_until_ts, chat_id)
  WHERE alert_safety = 1;
