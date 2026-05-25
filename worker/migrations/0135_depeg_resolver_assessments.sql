-- rollout-safety: backward-compatible
-- Durable DDR assessment ledger for the Depeg Duration Resolver Reviewer.
-- Stores bounded checkpoints of what DDR said while an event was active so
-- later review compares actual outcomes against the original public readout.
CREATE TABLE IF NOT EXISTS depeg_resolver_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  peg_currency TEXT NOT NULL,
  governance TEXT NOT NULL,
  direction TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  assessed_at INTEGER NOT NULL,
  event_age_sec INTEGER NOT NULL,
  checkpoint TEXT NOT NULL,
  methodology_version TEXT NOT NULL,
  methodology_version_label TEXT NOT NULL,
  resolution_rubric_version TEXT NOT NULL,
  duration_model_version TEXT NOT NULL,
  incident_grouping_version TEXT NOT NULL,
  support_rules_version TEXT NOT NULL,
  resolution_tier TEXT NOT NULL,
  duration_suppressed INTEGER NOT NULL,
  duration_suppressed_reason TEXT,
  median_remaining_sec INTEGER,
  iqr_low_remaining_sec INTEGER,
  iqr_high_remaining_sec INTEGER,
  stratum TEXT,
  horizons_json TEXT NOT NULL,
  factors_json TEXT NOT NULL,
  row_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(event_id, checkpoint, methodology_version)
);

CREATE INDEX IF NOT EXISTS idx_ddr_assessments_event
  ON depeg_resolver_assessments(event_id);

CREATE INDEX IF NOT EXISTS idx_ddr_assessments_lookup
  ON depeg_resolver_assessments(stablecoin_id, assessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_assessments_review
  ON depeg_resolver_assessments(checkpoint, assessed_at DESC);
