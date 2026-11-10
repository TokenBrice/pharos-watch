-- rollout-safety: backward-compatible

-- NULL is historical classification unknown, including hours rewritten by an
-- older Worker during rollout. Only a complete raw-hour rebuild may record 0.
-- Mints can be unresolved too: standard flow with burn_type='review_required'.
-- No data backfill: pruned hours must retain their unknown classification.
ALTER TABLE mint_burn_hourly ADD COLUMN mint_unresolved_event_count INTEGER;
ALTER TABLE mint_burn_hourly ADD COLUMN burn_unresolved_event_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_mbh_completeness_unrecorded
  ON mint_burn_hourly(hour_ts)
  WHERE mint_unpriced_event_count IS NULL OR burn_unpriced_event_count IS NULL
     OR mint_unresolved_event_count IS NULL OR burn_unresolved_event_count IS NULL;
