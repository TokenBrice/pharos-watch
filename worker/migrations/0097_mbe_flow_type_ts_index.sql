-- worker/migrations/0097_mbe_flow_type_ts_index.sql
-- Speed up the roundtrip-sweep query (and any future flow_type-filtered query)
-- by adding a composite index on (flow_type, timestamp). Backward-compatible.
CREATE INDEX IF NOT EXISTS idx_mbe_flow_type_ts
  ON mint_burn_events(flow_type, timestamp DESC);
