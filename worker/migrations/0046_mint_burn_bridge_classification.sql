-- Ethereum-only mint/burn scope + burn classification for bridge-aware accounting.

ALTER TABLE mint_burn_events ADD COLUMN burn_type TEXT;
ALTER TABLE mint_burn_events ADD COLUMN burn_review_reason TEXT;

-- Bootstrap existing rows:
-- - mint rows: burn_type stays NULL
-- - burn rows: default to effective_burn until backfill/classifier re-tags bridge flows
UPDATE mint_burn_events
SET burn_type = CASE
  WHEN direction = 'burn' THEN 'effective_burn'
  ELSE NULL
END,
    burn_review_reason = NULL
WHERE burn_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_mbe2_burn_type ON mint_burn_events(burn_type, timestamp DESC);

-- Drop previously ingested non-Ethereum mint/burn rows after Ethereum-only refactor.
DELETE FROM mint_burn_events WHERE chain_id <> 'ethereum';
DELETE FROM mint_burn_hourly WHERE chain_id <> 'ethereum';
DELETE FROM mint_burn_sync_state WHERE config_key NOT LIKE 'ethereum-%';

-- Rebuild hourly buckets with effective-burn accounting semantics.
DELETE FROM mint_burn_hourly;
INSERT OR REPLACE INTO mint_burn_hourly
  (stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
SELECT
  stablecoin_id,
  chain_id,
  (timestamp / 3600) * 3600 AS hour_ts,
  SUM(CASE WHEN direction = 'mint' THEN 1 ELSE 0 END),
  SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' THEN 1 ELSE 0 END),
  COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' THEN amount_usd ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd WHEN direction = 'burn' AND burn_type = 'effective_burn' THEN -amount_usd ELSE 0 END), 0)
FROM mint_burn_events
GROUP BY stablecoin_id, chain_id, hour_ts;
