-- Source-aware yield history.
-- Replaces coin-level best-source history with per-source rows keyed by
-- (stablecoin_id, source_key, recorded_at) while preserving legacy history as
-- `source_key = 'legacy-best'`.

CREATE TABLE yield_history_v2 (
  stablecoin_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  is_best INTEGER NOT NULL DEFAULT 0,
  apy REAL NOT NULL,
  apy_base REAL,
  apy_reward REAL,
  exchange_rate REAL,
  source_tvl_usd REAL,
  data_source TEXT NOT NULL,
  warning_signals TEXT,
  yield_source TEXT,
  yield_type TEXT,
  PRIMARY KEY (stablecoin_id, source_key, recorded_at)
);

INSERT INTO yield_history_v2 (
  stablecoin_id,
  source_key,
  recorded_at,
  is_best,
  apy,
  apy_base,
  apy_reward,
  exchange_rate,
  source_tvl_usd,
  data_source,
  warning_signals,
  yield_source,
  yield_type
)
SELECT
  stablecoin_id,
  'legacy-best' AS source_key,
  recorded_at,
  1 AS is_best,
  apy,
  apy_base,
  apy_reward,
  exchange_rate,
  source_tvl_usd,
  data_source,
  warning_signals,
  NULL AS yield_source,
  NULL AS yield_type
FROM yield_history;

DROP TABLE yield_history;
ALTER TABLE yield_history_v2 RENAME TO yield_history;

CREATE INDEX IF NOT EXISTS idx_yield_hist_coin
  ON yield_history(stablecoin_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_yield_hist_coin_source
  ON yield_history(stablecoin_id, source_key, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_yield_hist_best
  ON yield_history(stablecoin_id, is_best, recorded_at DESC);
