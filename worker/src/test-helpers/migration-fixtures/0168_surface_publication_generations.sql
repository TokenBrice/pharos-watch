-- rollout-safety: backward-compatible
-- 0168: Add a generic publication-generation ledger for cache-backed and
-- table-backed surfaces that do not already have an authoritative generation
-- table. Existing DEX-liquidity and yield publication writers remain on their
-- dedicated generation tables.

CREATE TABLE IF NOT EXISTS surface_publication_generations (
  surface TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  validated_at INTEGER,
  published_at INTEGER,
  state TEXT NOT NULL CHECK (
    state IN (
      'candidate',
      'validated',
      'published',
      'rejected',
      'superseded',
      'failed'
    )
  ),
  candidate_rows INTEGER,
  published_rows INTEGER,
  expected_rows INTEGER,
  previous_generation_id TEXT,
  input_watermarks_json TEXT,
  dependency_snapshot_json TEXT,
  validation_summary_json TEXT,
  artifact_checksum TEXT,
  artifact_cache_key TEXT,
  failure_reason TEXT,
  PRIMARY KEY (surface, generation_id)
);

CREATE INDEX IF NOT EXISTS idx_surface_publication_generations_surface_state_published
  ON surface_publication_generations(surface, state, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_surface_publication_generations_surface_started
  ON surface_publication_generations(surface, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_surface_publication_generations_surface_state_started
  ON surface_publication_generations(surface, state, started_at DESC);
