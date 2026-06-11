-- rollout-safety: backward-compatible

ALTER TABLE dex_liquidity ADD COLUMN publication_generation_id TEXT;
ALTER TABLE dex_liquidity ADD COLUMN publication_state TEXT;

CREATE TABLE IF NOT EXISTS dex_liquidity_publication_generations (
  generation_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'published', 'failed')),
  expected_row_count INTEGER NOT NULL,
  written_row_count INTEGER NOT NULL DEFAULT 0,
  current_row_count INTEGER,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  failed_at INTEGER,
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_generations_state_started
  ON dex_liquidity_publication_generations(state, started_at DESC);

CREATE TABLE IF NOT EXISTS dex_liquidity_run_rows (
  generation_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  total_tvl_usd REAL NOT NULL DEFAULT 0,
  total_volume_24h_usd REAL NOT NULL DEFAULT 0,
  total_volume_7d_usd REAL NOT NULL DEFAULT 0,
  pool_count INTEGER NOT NULL DEFAULT 0,
  pair_count INTEGER NOT NULL DEFAULT 0,
  chain_count INTEGER NOT NULL DEFAULT 0,
  protocol_tvl_json TEXT,
  chain_tvl_json TEXT,
  top_pools_json TEXT,
  liquidity_score INTEGER,
  concentration_hhi REAL,
  depth_stability REAL,
  avg_pool_stress REAL,
  weighted_balance_ratio REAL,
  organic_fraction REAL,
  effective_tvl_usd REAL NOT NULL DEFAULT 0,
  durability_score INTEGER,
  score_components_json TEXT,
  locked_liquidity_pct REAL,
  methodology_version TEXT NOT NULL DEFAULT '5.8',
  coverage_class TEXT NOT NULL DEFAULT 'unobserved',
  coverage_confidence REAL NOT NULL DEFAULT 0,
  source_mix_json TEXT,
  balance_measured_tvl_usd REAL NOT NULL DEFAULT 0,
  organic_measured_tvl_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (generation_id, stablecoin_id),
  FOREIGN KEY (generation_id) REFERENCES dex_liquidity_publication_generations(generation_id)
);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_run_rows_stablecoin
  ON dex_liquidity_run_rows(stablecoin_id, generation_id);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_publication_state
  ON dex_liquidity(publication_generation_id, publication_state);
