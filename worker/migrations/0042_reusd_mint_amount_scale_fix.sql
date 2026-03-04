-- reUSD mint parsing fix:
-- Deposited(address,address,uint256) amounts were decoded as 6 decimals but are 18-decimal units.
-- This inflated stored mint amounts (and USD values) by 1e12.

UPDATE mint_burn_events
SET
  amount = amount / 1000000000000.0,
  amount_usd = CASE
    WHEN amount_usd IS NULL THEN NULL
    ELSE amount_usd / 1000000000000.0
  END
WHERE stablecoin_id = '339'
  AND direction = 'mint'
  AND amount >= 1000000000;

-- Reapply the configured dust filter for reUSD mints (10,000 tokens).
-- Inflated rows bypassed this check before the parser fix.
DELETE FROM mint_burn_events
WHERE stablecoin_id = '339'
  AND direction = 'mint'
  AND amount < 10000;

-- Rebuild reUSD hourly aggregates after correcting/deleting affected events.
DELETE FROM mint_burn_hourly
WHERE stablecoin_id = '339';

INSERT OR REPLACE INTO mint_burn_hourly
  (stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
SELECT
  stablecoin_id,
  chain_id,
  (timestamp / 3600) * 3600 AS hour_ts,
  SUM(CASE WHEN direction = 'mint' THEN 1 ELSE 0 END) AS mint_count,
  SUM(CASE WHEN direction = 'burn' THEN 1 ELSE 0 END) AS burn_count,
  COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE 0 END), 0) AS mint_volume_usd,
  COALESCE(SUM(CASE WHEN direction = 'burn' THEN amount_usd ELSE 0 END), 0) AS burn_volume_usd,
  COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE -amount_usd END), 0) AS net_flow_usd
FROM mint_burn_events
WHERE stablecoin_id = '339'
GROUP BY stablecoin_id, chain_id, hour_ts;
