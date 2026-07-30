-- rollout-safety: backward-compatible
-- Repair Tangent USG historical supply rows written before the
-- on-chain-circulating supply exclusion was introduced.
-- Values are UTC day-close totalSupply minus the configured PegKeeper balances.

UPDATE supply_history
SET circulating_usd = CASE snapshot_date
  WHEN 1778112000 THEN 20000
  WHEN 1778198400 THEN 20000
  WHEN 1778284800 THEN 20000
  WHEN 1778371200 THEN 20000
  WHEN 1778457600 THEN 75602.73063102622
  WHEN 1778544000 THEN 173992.13725954157
  WHEN 1778630400 THEN 319738.67770567105
  ELSE circulating_usd
END
WHERE stablecoin_id = 'usg-tangent'
  AND snapshot_date IN (
    1778112000,
    1778198400,
    1778284800,
    1778371200,
    1778457600,
    1778544000,
    1778630400
  );
