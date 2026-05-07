-- rollout-safety: backward-compatible
-- 0109: Add an optional global depeg worsening threshold for all-stablecoin
-- Telegram depeg follows. Existing subscribers keep default global depeg
-- behavior until they opt into a step.

ALTER TABLE telegram_subscribers ADD COLUMN global_depeg_worsening_bps_step INTEGER;
