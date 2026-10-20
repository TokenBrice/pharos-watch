-- rollout-safety: backward-compatible
-- Nullable markers only: old named-column inserts/readers remain valid.
-- No history rewrite, public tombstone payload, or archive is introduced.
ALTER TABLE tape_events ADD COLUMN suppressed_at INTEGER;
ALTER TABLE tape_events ADD COLUMN suppression_reason TEXT;
