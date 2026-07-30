-- rollout-safety: backward-compatible
ALTER TABLE blacklist_events ADD COLUMN amount_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blacklist_events ADD COLUMN amount_last_attempted_at INTEGER;
ALTER TABLE blacklist_events ADD COLUMN amount_last_error_class TEXT;
ALTER TABLE blacklist_events ADD COLUMN amount_last_provider TEXT;
