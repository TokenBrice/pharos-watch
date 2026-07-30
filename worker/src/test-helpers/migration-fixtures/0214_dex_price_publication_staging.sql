-- rollout-safety: backward-compatible
-- Stage complete DEX price generations before atomically replacing dex_prices.

CREATE TABLE IF NOT EXISTS dex_price_run_rows (
  generation_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  dex_price_usd REAL NOT NULL,
  source_pool_count INTEGER NOT NULL,
  source_total_tvl REAL NOT NULL,
  deviation_from_primary_bps INTEGER,
  primary_price_at_calc REAL,
  price_sources_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (generation_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_dex_price_run_rows_retention
  ON dex_price_run_rows(updated_at, generation_id);
