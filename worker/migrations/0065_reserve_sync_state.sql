-- Tracks the latest operational state of each live reserve sync target.
CREATE TABLE IF NOT EXISTS reserve_sync_state (
  stablecoin_id     TEXT NOT NULL PRIMARY KEY,
  adapter_key       TEXT NOT NULL,
  breaker_key       TEXT NOT NULL,
  last_attempted_at INTEGER,
  last_success_at   INTEGER,
  last_status       TEXT NOT NULL,  -- ok | degraded | error | skipped
  warning_count     INTEGER NOT NULL DEFAULT 0,
  warnings          TEXT,           -- JSON array of warning messages / unknown inputs
  last_error        TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}'
);
