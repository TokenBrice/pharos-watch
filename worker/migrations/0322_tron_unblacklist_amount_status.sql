-- rollout-safety: backward-compatible
-- data-migration: reviewed
-- Tron unblacklist events do not emit amounts and Tron transfer-ledger replay
-- is scoped to freeze (blacklist) events, so amountless Tron releases cannot
-- recover an event-time amount (R4 / #2285). Terminalize existing gaps and
-- close their unreachable repair-queue rows.
UPDATE blacklist_events
SET amount_status = 'permanently_unavailable',
    amount_last_error_class = 'tron_release_amount_not_tracked'
WHERE chain_id = 'tron'
  AND event_type = 'unblacklist'
  AND amount_native IS NULL
  AND suppression_reason IS NULL
  AND amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous');

UPDATE blacklist_amount_repair_queue
SET status = 'unrecoverable',
    last_error_class = 'tron_release_amount_not_tracked',
    claim_token = NULL,
    lease_expires_at = NULL,
    completed_at = COALESCE(completed_at, unixepoch()),
    updated_at = unixepoch()
WHERE status IN ('pending', 'running', 'retry')
  AND event_id IN (
    SELECT id
    FROM blacklist_events
    WHERE chain_id = 'tron'
      AND event_type = 'unblacklist'
      AND amount_native IS NULL
      AND suppression_reason IS NULL
      AND amount_status = 'permanently_unavailable'
      AND amount_last_error_class = 'tron_release_amount_not_tracked'
  );
