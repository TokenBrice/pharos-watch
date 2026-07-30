-- rollout-safety: backward-compatible
-- 0205: Add generation-fenced target inventories and measured DEX execution
-- quote rows. The previous Worker ignores both additive tables.

CREATE TABLE IF NOT EXISTS dex_measured_execution_targets (
  generation_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  adapter_profile_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  chain TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  target_json TEXT NOT NULL,
  PRIMARY KEY (generation_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_dex_measured_targets_generation_coin
  ON dex_measured_execution_targets(generation_id, stablecoin_id, target_id);

CREATE INDEX IF NOT EXISTS idx_dex_measured_targets_pool
  ON dex_measured_execution_targets(chain, pool_id, stablecoin_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS dex_measured_execution_quotes (
  generation_id TEXT NOT NULL,
  target_generation_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  adapter_profile_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  chain TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('measured', 'failed')),
  failure_reason TEXT,
  quoted_at INTEGER,
  block_number INTEGER,
  quote_profile_json TEXT,
  raw_quote_payload_json TEXT,
  PRIMARY KEY (generation_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_dex_measured_quotes_generation_coin
  ON dex_measured_execution_quotes(generation_id, stablecoin_id, target_id);

CREATE INDEX IF NOT EXISTS idx_dex_measured_quotes_target_generation
  ON dex_measured_execution_quotes(target_generation_id, target_id);

