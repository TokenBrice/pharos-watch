-- rollout-safety: backward-compatible
-- Persist the first recovery observation so a live event only closes after the
-- recovery signal remains inside the recovery boundary for a full cron window.

ALTER TABLE depeg_events ADD COLUMN recovery_first_seen_at INTEGER;
