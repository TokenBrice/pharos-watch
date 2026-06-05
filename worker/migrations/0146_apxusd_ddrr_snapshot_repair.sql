-- rollout-safety: backward-compatible
-- Ensure the APXUSD incident repaired by 0145 is treated as ongoing by DDRR.
-- 0145 may already be recorded in D1's migration ledger, so repeat the exact
-- guarded reopen and invalidate the stale reviewer snapshot that scored it closed.

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

UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-apxusd-reopen","payload":{}}',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE key = 'depeg-resolver-review:snapshot';
