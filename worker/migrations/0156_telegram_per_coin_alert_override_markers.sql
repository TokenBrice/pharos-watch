-- rollout-safety: backward-compatible
-- Track which per-coin alert flags were set through settings-style overrides.
-- The existing alert_* columns remain binary follow flags; zero alone cannot
-- distinguish an explicit off override from an unmentioned alert type.
ALTER TABLE telegram_subscriptions ADD COLUMN alert_dews_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscriptions ADD COLUMN alert_depeg_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscriptions ADD COLUMN alert_safety_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscriptions ADD COLUMN alert_launch_override INTEGER NOT NULL DEFAULT 0;
