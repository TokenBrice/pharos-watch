-- Adds per-source tracking to yield_data:
--   source_key  TEXT NOT NULL  — DL pool UUID, or "price-derived"
--   is_best     INTEGER NOT NULL DEFAULT 1  — 1 = highest currentApy for this coin
-- PK changes from (stablecoin_id) to (stablecoin_id, source_key).
-- yield_history is unchanged.

CREATE TABLE yield_data_v2 (
  stablecoin_id       TEXT NOT NULL,
  source_key          TEXT NOT NULL,
  symbol              TEXT NOT NULL,
  current_apy         REAL NOT NULL,
  apy_base            REAL,
  apy_reward          REAL,
  apy_7d              REAL NOT NULL,
  apy_30d             REAL NOT NULL,
  yield_source        TEXT NOT NULL,
  yield_type          TEXT NOT NULL,
  source_pool         TEXT,
  source_tvl_usd      REAL,
  data_source         TEXT NOT NULL,
  safety_score        REAL,
  safety_grade        TEXT,
  pharos_yield_score  REAL,
  yield_to_risk       REAL,
  excess_yield        REAL,
  yield_stability     REAL,
  apy_variance_30d    REAL,
  apy_min_30d         REAL,
  apy_max_30d         REAL,
  exchange_rate       REAL,
  exchange_rate_prev  REAL,
  warning_signals     TEXT,
  is_best             INTEGER NOT NULL DEFAULT 1,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, source_key)
);

INSERT INTO yield_data_v2 (
  stablecoin_id, source_key, symbol, current_apy, apy_base, apy_reward,
  apy_7d, apy_30d, yield_source, yield_type, source_pool, source_tvl_usd,
  data_source, safety_score, safety_grade, pharos_yield_score, yield_to_risk,
  excess_yield, yield_stability, apy_variance_30d, apy_min_30d, apy_max_30d,
  exchange_rate, exchange_rate_prev, warning_signals, is_best, updated_at
)
SELECT
  stablecoin_id,
  COALESCE(source_pool, 'price-derived') AS source_key,
  symbol, current_apy, apy_base, apy_reward,
  apy_7d, apy_30d, yield_source, yield_type, source_pool, source_tvl_usd,
  data_source, safety_score, safety_grade, pharos_yield_score, yield_to_risk,
  excess_yield, yield_stability, apy_variance_30d, apy_min_30d, apy_max_30d,
  exchange_rate, exchange_rate_prev, warning_signals,
  1 AS is_best,
  updated_at
FROM yield_data;

DROP TABLE yield_data;
ALTER TABLE yield_data_v2 RENAME TO yield_data;

CREATE INDEX IF NOT EXISTS idx_yield_pys  ON yield_data(pharos_yield_score DESC);
CREATE INDEX IF NOT EXISTS idx_yield_apy  ON yield_data(apy_30d DESC);
CREATE INDEX IF NOT EXISTS idx_yield_best ON yield_data(stablecoin_id, is_best);
