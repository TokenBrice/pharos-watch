-- rollout-safety: backward-compatible
-- The post-run roundtrip sweep groups the retained standard-event window by
-- (tx_hash, stablecoin_id, chain_id) on every mint/burn lane completion.
-- idx_mbe_flow_type_ts only supplies the flow_type/timestamp range, so SQLite
-- built a temporary B-tree over ~82k groups and re-read every row (~1 s per run).
-- This covering key streams the groups instead. No row mutation.
CREATE INDEX IF NOT EXISTS idx_mbe_roundtrip_group
  ON mint_burn_events(flow_type, tx_hash, stablecoin_id, chain_id, timestamp, direction, amount);
