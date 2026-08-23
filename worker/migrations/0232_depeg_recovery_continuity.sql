-- rollout-safety: backward-compatible

ALTER TABLE depeg_events ADD COLUMN recovery_last_seen_at INTEGER;
