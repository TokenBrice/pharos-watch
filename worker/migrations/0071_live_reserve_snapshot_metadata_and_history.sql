-- rollout-safety: backward-compatible
-- Separate latest successful snapshot metadata from latest attempt state.
ALTER TABLE reserve_composition ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE reserve_composition ADD COLUMN warning_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reserve_composition ADD COLUMN warnings TEXT;
ALTER TABLE reserve_composition ADD COLUMN adapter_source_model TEXT;
ALTER TABLE reserve_composition ADD COLUMN adapter_evidence_class TEXT;

CREATE TABLE IF NOT EXISTS reserve_composition_history (
  id INTEGER PRIMARY KEY,
  stablecoin_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  adapter_key TEXT NOT NULL,
  slices TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  warnings TEXT,
  warning_count INTEGER NOT NULL DEFAULT 0,
  adapter_source_model TEXT,
  adapter_evidence_class TEXT
);

CREATE INDEX IF NOT EXISTS idx_reserve_composition_history_coin_time
  ON reserve_composition_history (stablecoin_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS reserve_sync_attempt_history (
  id INTEGER PRIMARY KEY,
  stablecoin_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  adapter_key TEXT NOT NULL,
  breaker_key TEXT NOT NULL,
  status TEXT NOT NULL,
  warnings TEXT,
  warning_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_reserve_sync_attempt_history_coin_time
  ON reserve_sync_attempt_history (stablecoin_id, attempted_at DESC);
