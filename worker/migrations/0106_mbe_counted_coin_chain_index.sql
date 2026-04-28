-- worker/migrations/0106_mbe_counted_coin_chain_index.sql
-- rollout-safety: backward-compatible
-- Speed up counted mint/burn event totals and page reads by indexing the
-- economic-flow subset used by /api/mint-burn-events?scope=counted.
CREATE INDEX IF NOT EXISTS idx_mbe_counted_coin_chain_ts
  ON mint_burn_events(stablecoin_id, chain_id, timestamp DESC)
  WHERE flow_type = 'standard'
    AND (direction = 'mint' OR burn_type = 'effective_burn');
