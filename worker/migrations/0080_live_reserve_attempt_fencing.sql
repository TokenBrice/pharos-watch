-- rollout-safety: backward-compatible

ALTER TABLE reserve_composition
  ADD COLUMN attempt_id TEXT;

ALTER TABLE reserve_composition_history
  ADD COLUMN attempt_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reserve_composition_history_coin_attempt
  ON reserve_composition_history(stablecoin_id, attempt_id);

ALTER TABLE reserve_sync_state
  ADD COLUMN last_attempt_id TEXT;

ALTER TABLE reserve_sync_state
  ADD COLUMN pending_attempt_id TEXT;

ALTER TABLE reserve_sync_state
  ADD COLUMN last_success_attempt_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reserve_sync_state_pending_attempt
  ON reserve_sync_state(pending_attempt_id);

CREATE INDEX IF NOT EXISTS idx_reserve_sync_state_last_success_attempt
  ON reserve_sync_state(last_success_attempt_id);

ALTER TABLE reserve_sync_attempt_history
  ADD COLUMN attempt_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reserve_sync_attempt_history_coin_attempt
  ON reserve_sync_attempt_history(stablecoin_id, attempt_id);
