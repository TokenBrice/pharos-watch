-- rollout-safety: backward-compatible
-- Track which per-coin alert flags were set through settings-style overrides.
-- The existing alert_* columns remain binary follow flags; zero alone cannot
-- distinguish an explicit off override from an unmentioned alert type.
ALTER TABLE telegram_subscriptions ADD COLUMN alert_dews_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_dews_override IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_depeg_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_depeg_override IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_safety_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_safety_override IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_launch_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_launch_override IN (0, 1));
ALTER TABLE telegram_subscriptions ADD COLUMN alert_reserve_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_reserve_override IN (0, 1));

-- Rows that already existed before the marker columns used alert_* = 0 as the
-- only persistent representation for an explicit per-coin off setting. Mark
-- those zeroes as overrides so the new dispatcher preserves historical opt-outs
-- while future partial follow writes can continue to rely on the default marker
-- value of 0 for unmentioned alert types.
UPDATE telegram_subscriptions
   SET alert_dews_override = CASE WHEN alert_dews = 0 THEN 1 ELSE alert_dews_override END,
       alert_depeg_override = CASE WHEN alert_depeg = 0 THEN 1 ELSE alert_depeg_override END,
       alert_safety_override = CASE WHEN alert_safety = 0 THEN 1 ELSE alert_safety_override END,
       alert_launch_override = CASE WHEN alert_launch = 0 THEN 1 ELSE alert_launch_override END,
       alert_reserve_override = CASE WHEN alert_reserve = 0 THEN 1 ELSE alert_reserve_override END;
