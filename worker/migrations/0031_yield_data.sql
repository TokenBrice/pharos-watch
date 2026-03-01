-- 0031_yield_data.sql
-- Yield Intelligence: current snapshots + historical data

CREATE TABLE IF NOT EXISTS yield_data (
  stablecoin_id   TEXT PRIMARY KEY,
  symbol          TEXT NOT NULL,
  current_apy     REAL NOT NULL,
  apy_base        REAL,
  apy_reward      REAL,
  apy_7d          REAL NOT NULL,
  apy_30d         REAL NOT NULL,
  yield_source    TEXT NOT NULL,
  yield_type      TEXT NOT NULL,
  source_pool     TEXT,
  source_tvl_usd  REAL,
  data_source     TEXT NOT NULL,
  safety_score    REAL,
  safety_grade    TEXT,
  pharos_yield_score  REAL,
  yield_to_risk       REAL,
  excess_yield        REAL,
  yield_stability     REAL,
  apy_variance_30d    REAL,
  apy_min_30d         REAL,
  apy_max_30d         REAL,
  exchange_rate       REAL,
  exchange_rate_prev  REAL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_yield_pys ON yield_data(pharos_yield_score DESC);
CREATE INDEX IF NOT EXISTS idx_yield_apy ON yield_data(apy_30d DESC);

CREATE TABLE IF NOT EXISTS yield_history (
  stablecoin_id   TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,
  apy             REAL NOT NULL,
  apy_base        REAL,
  apy_reward      REAL,
  exchange_rate   REAL,
  source_tvl_usd  REAL,
  data_source     TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_yield_hist_coin ON yield_history(stablecoin_id, recorded_at DESC);
