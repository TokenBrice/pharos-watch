-- rollout-safety: backward-compatible
-- Add per-coin temporary alert snooze. NULL means no active snooze.
-- When alert_snooze_until_ts > unixepoch(), dispatcher skips fan-out for
-- this specific (chat, stablecoin) subscription. Chat-level snooze on
-- telegram_subscribers.alert_snooze_until_ts continues to apply on top.
ALTER TABLE telegram_subscriptions ADD COLUMN alert_snooze_until_ts INTEGER;
