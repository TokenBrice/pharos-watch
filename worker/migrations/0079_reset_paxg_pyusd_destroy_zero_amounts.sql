-- rollout-safety: backward-compatible
-- Reset PAXG and pyUSD FrozenAddressWiped destroy events that were incorrectly
-- resolved with amount_native=0. PAXG's contract overrides balanceOf to return 0
-- for frozen addresses, so our historical balance lookup got false zeros. The fix
-- in sync-blacklist now extracts the real amount from co-emitted Transfer burn
-- events in the tx receipt. Setting these back to recoverable_pending lets the
-- backfill re-process them with the corrected logic.

UPDATE blacklist_events
SET amount_status = 'recoverable_pending',
    amount_source = 'unavailable',
    amount_native = NULL,
    amount_usd_at_event = NULL,
    amount = NULL
WHERE event_type = 'destroy'
  AND amount_native = 0
  AND amount_status = 'resolved'
  AND stablecoin IN ('PAXG', 'PYUSD')
  AND event_signature = 'FrozenAddressWiped(address)';
