-- rollout-safety: backward-compatible

ALTER TABLE yield_data ADD COLUMN publication_generation_id TEXT;
ALTER TABLE yield_data ADD COLUMN publication_state TEXT;

ALTER TABLE yield_history ADD COLUMN publication_generation_id TEXT;
ALTER TABLE yield_history ADD COLUMN publication_state TEXT;

CREATE TABLE IF NOT EXISTS yield_publication_generations (
  generation_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'published', 'failed')),
  cache_key TEXT NOT NULL DEFAULT 'yield-rankings',
  ranking_updated_at INTEGER,
  ranking_count INTEGER,
  source_row_count INTEGER,
  best_row_count INTEGER,
  decision_count INTEGER,
  published_at INTEGER,
  failed_at INTEGER,
  failure_reason TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_yield_publication_generations_state_started
  ON yield_publication_generations(state, started_at DESC);

CREATE TABLE IF NOT EXISTS yield_source_decisions (
  generation_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  selected_source_key TEXT NOT NULL,
  selected_confidence_tier TEXT NOT NULL,
  selected_data_source TEXT NOT NULL,
  selected_apy_30d REAL NOT NULL,
  selected_score REAL,
  selected_reason TEXT NOT NULL,
  previous_best_source_key TEXT,
  source_switch INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  alternatives_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (generation_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_yield_source_decisions_generation
  ON yield_source_decisions(generation_id, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_yield_data_publication_generation
  ON yield_data(publication_generation_id, publication_state);

CREATE INDEX IF NOT EXISTS idx_yield_history_publication_generation
  ON yield_history(publication_generation_id, publication_state, stablecoin_id, recorded_at DESC);
