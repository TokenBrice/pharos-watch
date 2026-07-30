-- rollout-safety: backward-compatible
-- 0108: Add nullable contract/config identity and success/failure metadata to
-- blacklist_current_balances. Existing address-scoped rows keep their IDs and
-- remain readable as legacy fallback rows; new worker writes use scoped IDs.

ALTER TABLE blacklist_current_balances ADD COLUMN config_key TEXT;
ALTER TABLE blacklist_current_balances ADD COLUMN contract_address TEXT;
ALTER TABLE blacklist_current_balances ADD COLUMN last_successful_observed_at INTEGER;
ALTER TABLE blacklist_current_balances ADD COLUMN consecutive_failures INTEGER;

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_identity
  ON blacklist_current_balances(stablecoin, chain_id, config_key, contract_address, LOWER(address));

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_legacy_identity
  ON blacklist_current_balances(stablecoin, chain_id, LOWER(address))
  WHERE config_key IS NULL AND contract_address IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_status_observed
  ON blacklist_current_balances(status, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_latest_identity
  ON blacklist_events(
    stablecoin,
    chain_id,
    LOWER(address),
    COALESCE(LOWER(config_key), ''),
    COALESCE(LOWER(contract_address), ''),
    timestamp DESC,
    id DESC
  )
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_latest_type_identity
  ON blacklist_events(
    event_type,
    stablecoin,
    chain_id,
    LOWER(address),
    COALESCE(LOWER(config_key), ''),
    COALESCE(LOWER(contract_address), ''),
    timestamp DESC,
    id DESC
  )
  WHERE suppression_reason IS NULL;
