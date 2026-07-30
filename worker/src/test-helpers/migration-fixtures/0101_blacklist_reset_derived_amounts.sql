-- rollout-safety: backward-compatible
-- 0101: Flush pre-v3.2 'derived' + orphan 'legacy_migration' rows into the
-- backfill pool so they receive a proper historical_balance or
-- current_balance_snapshot attribution. Tron rows go through
-- backfillTronFromLedger once marked recoverable_pending. Leaves
-- permanently_unavailable rows alone.
-- (Renumbered from planned 0100; slot 0099 was taken by admin_action_audit_log.)

UPDATE blacklist_events
SET amount_native = NULL,
    amount_usd_at_event = NULL,
    amount = NULL,
    amount_source = 'unavailable',
    amount_status = 'recoverable_pending',
    amount_attempt_count = 0,
    amount_last_attempted_at = NULL,
    amount_last_error_class = NULL,
    amount_last_provider = NULL
WHERE amount_source IN ('derived', 'legacy_migration')
  AND amount_status != 'permanently_unavailable';
