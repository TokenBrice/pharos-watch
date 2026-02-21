CREATE TABLE mint_burn_events (
  id TEXT PRIMARY KEY,
  stablecoin TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  chain_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  amount REAL NOT NULL,
  address TEXT,
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  explorer_tx_url TEXT NOT NULL
);

CREATE INDEX idx_mbe_timestamp ON mint_burn_events(timestamp DESC);
CREATE INDEX idx_mbe_stablecoin ON mint_burn_events(stablecoin);

CREATE TABLE mint_burn_sync_state (
  config_key TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL DEFAULT 0
);
