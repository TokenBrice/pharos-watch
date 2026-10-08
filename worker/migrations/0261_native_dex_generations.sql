-- rollout-safety: backward-compatible
-- Isolated diagnostic authority; existing Workers and native shadow stores are unchanged.
CREATE TABLE IF NOT EXISTS dex_native_generations (
  generation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL CHECK (profile_id IN ('orca-whirlpool-exact-v1', 'raydium-clmm-exact-v1')),
  source_generation_id TEXT,
  started_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL CHECK (published_at >= started_at),
  quote_count INTEGER NOT NULL CHECK (quote_count BETWEEN 0 AND 4),
  score_eligible INTEGER NOT NULL DEFAULT 0 CHECK (score_eligible = 0),
  UNIQUE (profile_id, generation_id)
);
CREATE INDEX IF NOT EXISTS idx_dex_native_generations_retention
  ON dex_native_generations(published_at, generation_id);
CREATE TABLE IF NOT EXISTS dex_native_generation_quotes (
  generation_id TEXT NOT NULL REFERENCES dex_native_generations(generation_id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  quote_json TEXT NOT NULL CHECK (json_valid(quote_json)),
  PRIMARY KEY (generation_id, target_id)
);
CREATE TABLE IF NOT EXISTS dex_native_publication_pointers (
  profile_id TEXT PRIMARY KEY CHECK (profile_id IN ('orca-whirlpool-exact-v1', 'raydium-clmm-exact-v1')),
  generation_id TEXT NOT NULL,
  FOREIGN KEY (profile_id, generation_id) REFERENCES dex_native_generations(profile_id, generation_id)
);
-- Reject incomplete atomic batches rather than advancing the pointer to torn evidence.
CREATE TRIGGER IF NOT EXISTS trg_dex_native_pointer_insert_complete
BEFORE INSERT ON dex_native_publication_pointers
WHEN NOT EXISTS (SELECT 1 FROM dex_native_generations g WHERE g.generation_id = NEW.generation_id
  AND g.profile_id = NEW.profile_id AND g.quote_count =
    (SELECT COUNT(*) FROM dex_native_generation_quotes q WHERE q.generation_id = g.generation_id))
BEGIN SELECT RAISE(ABORT, 'native-generation-incomplete'); END;
CREATE TRIGGER IF NOT EXISTS trg_dex_native_pointer_update_complete
BEFORE UPDATE ON dex_native_publication_pointers
WHEN NOT EXISTS (SELECT 1 FROM dex_native_generations g WHERE g.generation_id = NEW.generation_id
  AND g.profile_id = NEW.profile_id AND g.quote_count =
    (SELECT COUNT(*) FROM dex_native_generation_quotes q WHERE q.generation_id = g.generation_id))
BEGIN SELECT RAISE(ABORT, 'native-generation-incomplete'); END;
