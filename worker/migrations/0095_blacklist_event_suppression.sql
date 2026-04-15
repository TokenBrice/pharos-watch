-- rollout-safety: backward-compatible
-- Add optional suppression metadata for rows that should remain auditable but
-- stay out of public active/frozen aggregate semantics.

ALTER TABLE blacklist_events
  ADD COLUMN suppression_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_suppression_reason
  ON blacklist_events(suppression_reason);

UPDATE blacklist_events
SET suppression_reason = 'circle_mirror_zero_balance'
WHERE stablecoin = 'EURC'
  AND event_type IN ('blacklist', 'unblacklist')
  AND COALESCE(amount_native, amount, 0) = 0;

DELETE FROM blacklist_current_balances
WHERE stablecoin = 'EURC'
  AND COALESCE(amount_native, 0) = 0;
