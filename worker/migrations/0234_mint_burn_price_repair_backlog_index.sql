-- rollout-safety: backward-compatible

-- Backfill the historical-price-repair backlog index into migration lineage.
-- Production already carries this index (created directly during the repair
-- rollout); fresh databases were missing it, so the backlog scan in
-- mint-burn-historical-price-repair.ts (WHERE amount_usd IS NULL ordered by
-- price_repair_attempted_at, timestamp, id) had no matching index off
-- production. IF NOT EXISTS makes the production apply a no-op.
CREATE INDEX IF NOT EXISTS idx_mbe_historical_price_repair_backlog
  ON mint_burn_events(price_repair_status, price_repair_attempted_at ASC, timestamp ASC, id ASC)
  WHERE amount_usd IS NULL OR price_repair_status = 'pending_aggregate';
