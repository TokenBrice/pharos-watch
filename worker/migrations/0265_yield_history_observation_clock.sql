-- rollout-safety: backward-compatible
-- Preserve oracle observation time independently of history publication time.
-- Existing rows remain unknown; never infer observation time from recorded_at.
ALTER TABLE yield_history ADD COLUMN source_observed_at INTEGER;
ALTER TABLE yield_history_daily ADD COLUMN source_observed_at INTEGER;
