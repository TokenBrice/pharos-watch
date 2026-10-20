-- rollout-safety: backward-compatible
-- Prospective proof only: legacy cursors/events do not establish scanned coverage.
CREATE TABLE IF NOT EXISTS mint_burn_scan_coverage (
  config_key TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  from_block INTEGER NOT NULL CHECK (from_block >= 0),
  to_block INTEGER NOT NULL CHECK (to_block >= from_block),
  from_timestamp INTEGER NOT NULL CHECK (from_timestamp > 0),
  to_timestamp INTEGER NOT NULL CHECK (to_timestamp >= from_timestamp),
  finality_tag TEXT NOT NULL CHECK (finality_tag = 'finalized'),
  finalized_block INTEGER NOT NULL CHECK (finalized_block >= to_block),
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= to_timestamp),
  PRIMARY KEY (config_key, config_fingerprint, from_block)
);
