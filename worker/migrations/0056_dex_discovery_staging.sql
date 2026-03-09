-- Pool discovery staging table
CREATE TABLE IF NOT EXISTS dex_pool_staging (
  pool_id       TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  source        TEXT NOT NULL,
  chain         TEXT NOT NULL,
  protocol      TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  tvl_usd       REAL,
  volume_24h    REAL,
  fee_tier      REAL,
  balance_ratio REAL,
  is_stable     INTEGER,
  base_token    TEXT,
  quote_token   TEXT,
  quote_symbol  TEXT,
  price_usd     REAL,
  locked_liq_pct REAL,
  raw_json      TEXT,
  discovered_at INTEGER NOT NULL,
  refreshed_at  INTEGER NOT NULL,
  PRIMARY KEY (pool_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_staging_coin ON dex_pool_staging(stablecoin_id);
CREATE INDEX IF NOT EXISTS idx_staging_refreshed ON dex_pool_staging(refreshed_at);

-- Discovery backoff tracking
CREATE TABLE IF NOT EXISTS dex_discovery_meta (
  stablecoin_id       TEXT PRIMARY KEY,
  consecutive_misses  INTEGER NOT NULL DEFAULT 0,
  last_crawl_at       INTEGER NOT NULL,
  last_hit_at         INTEGER
);

-- Key-value config (used for discovery_run_seq counter)
CREATE TABLE IF NOT EXISTS kv_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
