-- rollout-safety: backward-compatible
-- Split DEX source/pool construction from scoring with a generation-fenced,
-- bounded D1 handoff. Older Workers ignore these additive tables.

CREATE TABLE IF NOT EXISTS dex_liquidity_scoring_stages (
  generation_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  state TEXT NOT NULL CHECK (state IN ('writing', 'ready', 'consumed', 'failed')),
  source_slot_started_at INTEGER NOT NULL CHECK (source_slot_started_at >= 0),
  sync_started_at INTEGER NOT NULL CHECK (sync_started_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  ready_at INTEGER,
  consumed_at INTEGER,
  expected_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_chunk_count >= 0),
  written_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (written_chunk_count >= 0),
  expected_record_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_record_count >= 0),
  payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
  failure_reason TEXT,
  UNIQUE (source_slot_started_at)
);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_scoring_stages_slot
  ON dex_liquidity_scoring_stages (source_slot_started_at DESC);

CREATE TABLE IF NOT EXISTS dex_liquidity_scoring_stage_chunks (
  generation_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0 AND payload_bytes <= 196608),
  record_count INTEGER NOT NULL CHECK (record_count > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (generation_id, chunk_index),
  FOREIGN KEY (generation_id)
    REFERENCES dex_liquidity_scoring_stages(generation_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_scoring_stage_chunks_retention
  ON dex_liquidity_scoring_stage_chunks (created_at, generation_id);
