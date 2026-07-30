-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS redemption_backstop_run_rows (
  snapshot_run_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  score REAL,
  effective_exit_score REAL,
  dex_liquidity_score REAL,
  access_score REAL,
  settlement_score REAL,
  execution_certainty_score REAL,
  capacity_score REAL,
  output_asset_quality_score REAL,
  cost_score REAL,
  route_family TEXT NOT NULL,
  access_model TEXT NOT NULL,
  settlement_model TEXT NOT NULL,
  execution_model TEXT NOT NULL,
  output_asset_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  immediate_capacity_usd REAL,
  immediate_capacity_ratio REAL,
  fee_bps REAL,
  queue_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  methodology_version TEXT NOT NULL,
  details_json TEXT,
  PRIMARY KEY (snapshot_run_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_run_rows_run_id
  ON redemption_backstop_run_rows(snapshot_run_id);
