-- rollout-safety: backward-compatible
-- Track which per-coin alert flags were set through settings-style overrides.
-- The existing alert_* columns remain binary follow flags; zero alone cannot
-- distinguish an explicit off override from an unmentioned alert type.
ALTER TABLE telegram_subscriptions ADD COLUMN alert_dews_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_dews_override IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_depeg_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_depeg_override IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_safety_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_safety_override IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_launch_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_launch_override IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_reserve_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_reserve_override IN (0, 1));
