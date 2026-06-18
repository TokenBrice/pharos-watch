-- rollout-safety: backward-compatible
-- Add reserve-drift alert type for transition-gated per-coin opt-in notifications
ALTER TABLE telegram_subscribers ADD COLUMN alert_reserve INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscribers ADD COLUMN global_alert_reserve INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscriptions ADD COLUMN alert_reserve INTEGER NOT NULL DEFAULT 0;
