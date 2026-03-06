-- SCHEMA-003: Composite covering index for mint_burn_events hot query
-- Covers: WHERE stablecoin_id = ? AND chain_id = ? ORDER BY timestamp DESC
CREATE INDEX IF NOT EXISTS idx_mbe_coin_chain_ts
ON mint_burn_events (stablecoin_id, chain_id, timestamp DESC);

-- SCHEMA-004: Index for health symbol aggregation
-- Covers: WHERE symbol IN (...) → GROUP BY symbol, MAX(timestamp)
CREATE INDEX IF NOT EXISTS idx_mbe_symbol_ts
ON mint_burn_events (symbol, timestamp DESC);
