-- rollout-safety: backward-compatible
-- The pending-confirmation canary counts recent unconfirmed-severe outcomes on
-- every 15-minute run. Without this access path the count scans the unpruned
-- outcome archive instead of seeking the outcome and clock range.
CREATE INDEX IF NOT EXISTS idx_depeg_pending_outcomes_outcome_time
  ON depeg_pending_outcomes(outcome, outcome_at DESC);
