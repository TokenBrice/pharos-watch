-- rollout-safety: backward-compatible

ALTER TABLE depeg_resolver_lock_opportunity_audit ADD COLUMN attempt_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_lock_opportunity_attempt_key
  ON depeg_resolver_lock_opportunity_audit(attempt_key)
  WHERE attempt_key IS NOT NULL;
