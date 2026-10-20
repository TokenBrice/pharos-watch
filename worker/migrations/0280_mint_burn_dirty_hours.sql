-- rollout-safety: backward-compatible
-- Durable maintenance rebuild debt; source mutations enqueue in their own atomic batch.
CREATE TABLE IF NOT EXISTS mint_burn_dirty_hours (
  stablecoin_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, chain_id, hour_ts)
);
