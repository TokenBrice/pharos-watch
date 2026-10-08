-- rollout-safety: backward-compatible
-- Change-only compact accepted cards; full publication attempts remain separately addressable.
CREATE TABLE IF NOT EXISTS safety_score_publication_journal (
  generation_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  methodology_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  evaluation_build_digest TEXT NOT NULL,
  score REAL,
  grade TEXT,
  compact_digest TEXT NOT NULL,
  compact_json TEXT NOT NULL CHECK (json_valid(compact_json)),
  input_lineage_json TEXT NOT NULL CHECK (json_valid(input_lineage_json)),
  PRIMARY KEY (generation_id, stablecoin_id)
);
CREATE INDEX IF NOT EXISTS idx_safety_score_journal_coin_time
  ON safety_score_publication_journal (stablecoin_id, published_at DESC, generation_id DESC);
CREATE INDEX IF NOT EXISTS idx_safety_score_journal_retention
  ON safety_score_publication_journal (published_at, generation_id, stablecoin_id);

CREATE TABLE IF NOT EXISTS safety_score_publication_attempts (
  attempt_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'held')),
  hold_reason_codes_json TEXT NOT NULL CHECK (json_valid(hold_reason_codes_json)),
  methodology_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  evaluation_build_digest TEXT NOT NULL,
  input_lineage_json TEXT NOT NULL CHECK (json_valid(input_lineage_json)),
  changed_cards INTEGER,
  unchanged_cards INTEGER,
  CHECK ((outcome = 'held' AND changed_cards IS NULL AND unchanged_cards IS NULL)
    OR (outcome = 'accepted' AND changed_cards IS NOT NULL AND unchanged_cards IS NOT NULL
      AND changed_cards >= 0 AND unchanged_cards >= 0))
);
CREATE INDEX IF NOT EXISTS idx_safety_score_attempts_time
  ON safety_score_publication_attempts (attempted_at, attempt_id);
CREATE INDEX IF NOT EXISTS idx_safety_score_attempts_generation
  ON safety_score_publication_attempts (generation_id);
