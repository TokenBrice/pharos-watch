-- Individual mint/burn events
CREATE TABLE IF NOT EXISTS mint_burn_events (
  id TEXT PRIMARY KEY,                 -- "{chainId}-{txHash}-{logIndex}"
  stablecoin_id TEXT NOT NULL,         -- Pharos stablecoin ID ("1", "2", "5", "118", etc.)
  symbol TEXT NOT NULL,                -- "USDT", "USDC", "DAI", "GHO", etc.
  chain_id TEXT NOT NULL,              -- "ethereum", "tron", etc.
  direction TEXT NOT NULL,             -- "mint" or "burn"
  amount REAL NOT NULL,                -- Token-native amount (e.g., 1000000.5 USDC)
  amount_usd REAL,                     -- USD value at time of event (NULL if price unavailable)
  counterparty TEXT,                   -- Address that received minted tokens or sent burned tokens
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,          -- Unix seconds
  explorer_tx_url TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mbe2_ts ON mint_burn_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mbe2_coin ON mint_burn_events(stablecoin_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mbe2_chain ON mint_burn_events(chain_id, timestamp DESC);

-- Pre-aggregated hourly flow buckets (written by cron after each scan)
CREATE TABLE IF NOT EXISTS mint_burn_hourly (
  stablecoin_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,            -- Unix seconds, truncated to hour boundary
  mint_count INTEGER NOT NULL DEFAULT 0,
  burn_count INTEGER NOT NULL DEFAULT 0,
  mint_volume_usd REAL NOT NULL DEFAULT 0,
  burn_volume_usd REAL NOT NULL DEFAULT 0,
  net_flow_usd REAL NOT NULL DEFAULT 0, -- mint_volume - burn_volume (positive = net mint)
  PRIMARY KEY (stablecoin_id, chain_id, hour_ts)
);

CREATE INDEX IF NOT EXISTS idx_mbh_ts ON mint_burn_hourly(hour_ts DESC);
CREATE INDEX IF NOT EXISTS idx_mbh_coin ON mint_burn_hourly(stablecoin_id, hour_ts DESC);

-- Incremental block tracking (same pattern as blacklist_sync_state)
CREATE TABLE IF NOT EXISTS mint_burn_sync_state (
  config_key TEXT PRIMARY KEY,         -- "{chainId}-{contractAddress}"
  last_block INTEGER NOT NULL DEFAULT 0
);
