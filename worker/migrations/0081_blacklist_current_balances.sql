-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS blacklist_current_balances (
  id TEXT PRIMARY KEY,
  stablecoin TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  address TEXT NOT NULL,
  amount_native REAL,
  amount_usd REAL,
  source TEXT NOT NULL DEFAULT 'current_balance',
  status TEXT NOT NULL DEFAULT 'resolved',
  observed_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at INTEGER,
  last_error_class TEXT
);

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_chain_stablecoin
  ON blacklist_current_balances(chain_id, stablecoin);

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_status
  ON blacklist_current_balances(status);

UPDATE blacklist_events
SET amount = NULL,
    amount_native = NULL,
    amount_usd_at_event = NULL,
    amount_source = 'unavailable',
    amount_status = 'permanently_unavailable'
WHERE chain_id = 'tron'
  AND event_type IN ('blacklist', 'unblacklist')
  AND amount_source = 'derived';
