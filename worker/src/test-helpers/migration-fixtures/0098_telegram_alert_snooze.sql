-- rollout-safety: backward-compatible
-- Add per-chat temporary alert snooze. NULL means no active snooze.
-- When alert_snooze_until_ts > unixepoch(), dispatcher skips fan-out for this chat.
ALTER TABLE telegram_subscribers ADD COLUMN alert_snooze_until_ts INTEGER;
