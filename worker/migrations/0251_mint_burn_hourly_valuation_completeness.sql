-- rollout-safety: backward-compatible

-- Mint/burn valuation completeness (CR-18 release A, D11-2). Per-side counts of
-- counted events (standard mints, standard effective burns) that carry no USD
-- valuation. mint_volume_usd / burn_volume_usd / net_flow_usd keep their meaning
-- as known-valuation subtotals: exact only when the matching count is 0.
--
-- NULL marks a bucket aggregated before coverage was recorded (unknown on any
-- side with counted events; a side with zero counted events is provably
-- complete). Previous Workers neither read nor write these columns, and their
-- INSERT OR REPLACE rewrites leave them NULL, so rows they write stay unknown.
-- No backfill here: the new Worker rebuilds legacy buckets whose raw events are
-- still inside the event-retention window; older buckets stay unknown. The
-- partial index keeps that bounded rebuild scan to unrecorded buckets only; it
-- empties as legacy buckets are rebuilt or age out of hourly retention.
ALTER TABLE mint_burn_hourly ADD COLUMN mint_unpriced_event_count INTEGER;
ALTER TABLE mint_burn_hourly ADD COLUMN burn_unpriced_event_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_mbh_valuation_unrecorded
  ON mint_burn_hourly(hour_ts)
  WHERE mint_unpriced_event_count IS NULL OR burn_unpriced_event_count IS NULL;
