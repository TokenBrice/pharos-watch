-- rollout-safety: backward-compatible
-- Add launch alert type for pre-launch → active promotion notifications
ALTER TABLE telegram_subscribers ADD COLUMN alert_launch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscribers ADD COLUMN global_alert_launch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscriptions ADD COLUMN alert_launch INTEGER NOT NULL DEFAULT 0;
