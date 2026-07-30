-- rollout-safety: backward-compatible
-- Persist provider availability, fair-run cursors, resumable DEX pagination,
-- and exact deployment coverage outcomes without changing existing readers.

CREATE TABLE IF NOT EXISTS pricing_provider_runtime_state (
  provider_id TEXT PRIMARY KEY,
  availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'blocked')),
  blocked_status INTEGER,
  blocked_at INTEGER,
  next_probe_at INTEGER,
  last_probe_at INTEGER,
  consecutive_blocked INTEGER NOT NULL DEFAULT 0,
  target_cursor INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_provider_negative_cache (
  provider_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  status INTEGER NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, target_key)
);

CREATE INDEX IF NOT EXISTS idx_pricing_provider_negative_cache_expiry
  ON pricing_provider_negative_cache(provider_id, expires_at);

CREATE TABLE IF NOT EXISTS dex_source_pagination_state (
  source_key TEXT PRIMARY KEY,
  cursor TEXT,
  cycle_started_at INTEGER,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS dex_deployment_outcomes (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('observed_pools', 'verified_no_pools', 'provider_inaccessible')),
  provider_set_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  observed_pool_count INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL,
  waiver_owner TEXT,
  waiver_reason TEXT,
  waiver_expires_at INTEGER,
  PRIMARY KEY (stablecoin_id, chain, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_dex_deployment_outcomes_outcome
  ON dex_deployment_outcomes(outcome, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dex_deployment_outcomes_stablecoin
  ON dex_deployment_outcomes(stablecoin_id, outcome);
