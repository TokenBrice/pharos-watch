-- rollout-safety: backward-compatible
-- Defer chronically failing mint/burn configs for a grace period so they
-- don't starve healthy configs of subrequest budget.
CREATE TABLE IF NOT EXISTS mint_burn_config_deferral (
  config_key TEXT PRIMARY KEY,
  deferred_until INTEGER NOT NULL,
  reason TEXT NOT NULL,
  api_errors INTEGER NOT NULL DEFAULT 0,
  coverage REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mbcd_until ON mint_burn_config_deferral(deferred_until);
