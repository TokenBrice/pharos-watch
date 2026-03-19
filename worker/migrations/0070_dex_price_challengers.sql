CREATE TABLE IF NOT EXISTS dex_price_challengers (
  stablecoin_id TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  pool_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  protocol TEXT NOT NULL,
  source_family TEXT NOT NULL,
  price_usd REAL NOT NULL,
  tvl_usd REAL NOT NULL,
  PRIMARY KEY (stablecoin_id, snapshot_at, pool_id)
);

CREATE INDEX IF NOT EXISTS idx_dex_price_challengers_lookup
  ON dex_price_challengers(stablecoin_id, snapshot_at);

CREATE TABLE IF NOT EXISTS dex_price_challenger_snapshots (
  stablecoin_id TEXT PRIMARY KEY,
  snapshot_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  has_rows INTEGER NOT NULL CHECK (has_rows IN (0, 1)),
  source_coverage_complete INTEGER NOT NULL CHECK (source_coverage_complete IN (0, 1))
);
