-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS yield_source_decision_alternatives (
  generation_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  alt_source_key TEXT NOT NULL,
  alt_yield_source TEXT NOT NULL,
  alt_apy30d_delta REAL,
  rejection_reason_code TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (generation_id, stablecoin_id, alt_source_key)
);

CREATE INDEX IF NOT EXISTS idx_yield_decision_alternatives_coin
  ON yield_source_decision_alternatives (stablecoin_id, recorded_at DESC);
