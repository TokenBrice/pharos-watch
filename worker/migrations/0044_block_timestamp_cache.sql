CREATE TABLE IF NOT EXISTS block_timestamp_cache (
  chain_id TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE INDEX IF NOT EXISTS idx_block_timestamp_cache_updated
  ON block_timestamp_cache(updated_at DESC);

