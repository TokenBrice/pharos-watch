-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS stress_signals_latest (
  stablecoin_id TEXT PRIMARY KEY,
  computed_at INTEGER NOT NULL,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stress_latest_computed
  ON stress_signals_latest(computed_at DESC);

INSERT OR REPLACE INTO stress_signals_latest (
  stablecoin_id,
  computed_at,
  score,
  band,
  signals_json,
  updated_at
)
SELECT
  s.stablecoin_id,
  s.computed_at,
  s.score,
  s.band,
  s.signals_json,
  s.computed_at
FROM stress_signals s
INNER JOIN (
  SELECT stablecoin_id, MAX(computed_at) AS max_at
  FROM stress_signals
  GROUP BY stablecoin_id
) latest
  ON latest.stablecoin_id = s.stablecoin_id
 AND latest.max_at = s.computed_at;

CREATE INDEX IF NOT EXISTS idx_mbh_chain_hour_coin
  ON mint_burn_hourly(chain_id, hour_ts, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_mbh_chain_coin_hour
  ON mint_burn_hourly(chain_id, stablecoin_id, hour_ts);

CREATE INDEX IF NOT EXISTS idx_yield_source_decisions_coin_created
  ON yield_source_decisions(stablecoin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_yield_history_best_recorded_coin
  ON yield_history(is_best, recorded_at DESC, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_yield_history_recorded_coin
  ON yield_history(recorded_at DESC, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_depeg_started_id
  ON depeg_events(started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_depeg_coin_started_id
  ON depeg_events(stablecoin_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_depeg_open_started_id
  ON depeg_events(started_at DESC, id DESC)
  WHERE ended_at IS NULL;
