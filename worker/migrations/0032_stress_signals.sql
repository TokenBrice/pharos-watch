-- Depeg Early Warning Score (DEWS) tables
-- 15-minute rolling samples (pruned to 7 days)
CREATE TABLE IF NOT EXISTS stress_signals (
  stablecoin_id TEXT NOT NULL,
  computed_at   INTEGER NOT NULL,    -- Unix seconds
  score         REAL NOT NULL,       -- Composite DEWS 0-100
  band          TEXT NOT NULL,       -- CALM | WATCH | ALERT | WARNING | DANGER
  signals_json  TEXT NOT NULL,       -- JSON: per-signal breakdown
  PRIMARY KEY (stablecoin_id, computed_at)
);

CREATE INDEX IF NOT EXISTS idx_stress_computed ON stress_signals(computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_stress_coin_date ON stress_signals(stablecoin_id, computed_at DESC);

-- Daily snapshots (pruned to 365 days)
CREATE TABLE IF NOT EXISTS stress_signal_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,    -- UTC midnight epoch seconds
  score         REAL NOT NULL,
  band          TEXT NOT NULL,
  signals_json  TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_stress_hist_date ON stress_signal_history(snapshot_date DESC);
