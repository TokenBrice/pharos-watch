-- rollout-safety: backward-compatible
-- Add per-chat IANA timezone for resolving quiet hours locally. NULL means
-- "interpret quiet_hours_start_utc/quiet_hours_end_utc as UTC" — the existing
-- behavior for every subscriber prior to this migration.
ALTER TABLE telegram_subscribers ADD COLUMN timezone TEXT;
