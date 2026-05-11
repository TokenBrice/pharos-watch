-- rollout-safety: backward-compatible

CREATE UNIQUE INDEX IF NOT EXISTS idx_reserve_composition_history_coin_attempt_unique
  ON reserve_composition_history(stablecoin_id, attempt_id)
  WHERE attempt_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reserve_sync_attempt_history_coin_attempt_unique
  ON reserve_sync_attempt_history(stablecoin_id, attempt_id)
  WHERE attempt_id IS NOT NULL;
