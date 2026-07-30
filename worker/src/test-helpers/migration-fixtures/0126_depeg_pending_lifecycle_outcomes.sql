-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS depeg_pending_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_id INTEGER,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  reason TEXT NOT NULL,
  first_seen_bps INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_price REAL NOT NULL,
  last_seen_bps INTEGER,
  last_seen_at INTEGER,
  last_price REAL,
  peak_seen_bps INTEGER,
  peak_price REAL,
  peg_reference REAL NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('promoted', 'rejected', 'expired', 'recovered', 'superseded', 'unconfirmed-severe')),
  outcome_at INTEGER NOT NULL,
  confirming_sources TEXT,
  opposing_sources TEXT,
  unavailable_sources TEXT,
  circuit_open_sources TEXT,
  final_decision_reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_depeg_pending_outcomes_stablecoin_time
  ON depeg_pending_outcomes(stablecoin_id, outcome_at DESC);

CREATE INDEX IF NOT EXISTS idx_depeg_pending_outcomes_pending_id
  ON depeg_pending_outcomes(pending_id);
