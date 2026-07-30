-- rollout-safety: backward-compatible
-- Reopen the APXUSD below-peg incident that was closed from a bad near-peg
-- soft consensus while high-TVL Curve DEX evidence still showed the depeg.
-- Keep the guards exact so this migration no-ops outside the known bad row.

UPDATE depeg_events
SET ended_at = NULL,
    recovery_price = NULL
WHERE id = 90055
  AND stablecoin_id = 'apxusd-apyx'
  AND symbol = 'apxUSD'
  AND direction = 'below'
  AND source = 'live'
  AND started_at = 1780446889
  AND ended_at = 1780630656;
