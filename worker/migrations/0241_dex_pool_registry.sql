-- rollout-safety: backward-compatible
--
-- The live Worker continues to read and write the original table while this
-- migration is applied. Retain it for Worker rollback; the new Worker reads
-- and writes independent per-source observations in the registry.

CREATE TABLE IF NOT EXISTS dex_pool_registry (
  pool_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  source TEXT NOT NULL,
  chain TEXT NOT NULL,
  protocol TEXT NOT NULL,
  dex_id TEXT,
  symbol TEXT NOT NULL,
  tvl_usd REAL,
  volume_24h REAL,
  quality_multiplier REAL,
  pool_type TEXT,
  fee_tier REAL,
  balance_ratio REAL,
  is_stable INTEGER,
  base_token TEXT,
  quote_token TEXT,
  quote_symbol TEXT,
  price_usd REAL,
  locked_liq_pct REAL,
  raw_json TEXT,
  discovered_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, pool_id, source)
);

CREATE INDEX IF NOT EXISTS idx_dex_pool_registry_refreshed
  ON dex_pool_registry (refreshed_at);

INSERT OR IGNORE INTO dex_pool_registry (
  pool_id, stablecoin_id, source, chain, protocol, dex_id, symbol,
  tvl_usd, volume_24h, quality_multiplier, pool_type, fee_tier, balance_ratio,
  is_stable, base_token, quote_token, quote_symbol, price_usd, locked_liq_pct,
  raw_json, discovered_at, refreshed_at
)
SELECT pool_id, stablecoin_id, source, chain, protocol, dex_id, symbol,
       tvl_usd, volume_24h, quality_multiplier, pool_type, fee_tier, balance_ratio,
       is_stable, base_token, quote_token, quote_symbol, price_usd, locked_liq_pct,
       raw_json, discovered_at, refreshed_at
  FROM dex_pool_staging;
