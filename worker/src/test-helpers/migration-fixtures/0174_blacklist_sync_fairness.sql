-- rollout-safety: backward-compatible
-- Add typed, generation-fenced blacklist cursor state while retaining
-- last_block for compatibility with the previous Worker version.

ALTER TABLE blacklist_sync_state
  ADD COLUMN cursor_kind TEXT NOT NULL DEFAULT 'evm_block';

ALTER TABLE blacklist_sync_state
  ADD COLUMN cursor_value INTEGER;

ALTER TABLE blacklist_sync_state
  ADD COLUMN attempt_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE blacklist_sync_state
  ADD COLUMN last_attempted_at INTEGER;

ALTER TABLE blacklist_sync_state
  ADD COLUMN last_succeeded_at INTEGER;

ALTER TABLE blacklist_sync_state
  ADD COLUMN last_skipped_at INTEGER;

ALTER TABLE blacklist_sync_state
  ADD COLUMN last_failed_at INTEGER;

ALTER TABLE blacklist_sync_state
  ADD COLUMN consecutive_skips INTEGER NOT NULL DEFAULT 0;

ALTER TABLE blacklist_sync_state
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE blacklist_sync_state
  ADD COLUMN last_outcome TEXT;

ALTER TABLE blacklist_sync_state
  ADD COLUMN last_observed_safe_head INTEGER;

ALTER TABLE blacklist_sync_state
  ADD COLUMN last_safe_head_observed_at INTEGER;

UPDATE blacklist_sync_state
SET
  cursor_kind = CASE
    WHEN config_key LIKE 'tron-%' THEN 'tron_timestamp_ms'
    ELSE 'evm_block'
  END,
  cursor_value = last_block
WHERE cursor_value IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_sync_state_fair_attempt
  ON blacklist_sync_state(cursor_kind, last_attempted_at, config_key);
