-- rollout-safety: backward-compatible
-- Add version-aware Safety Score history without changing or replacing the
-- legacy daily history table used by the current public response.

CREATE TABLE IF NOT EXISTS safety_score_history_v2 (
  history_id TEXT PRIMARY KEY NOT NULL CHECK (length(history_id) > 0),
  stablecoin_id TEXT NOT NULL CHECK (length(stablecoin_id) > 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  model TEXT NOT NULL CHECK (model IN ('v8', 'v9')),
  methodology_version TEXT NOT NULL CHECK (length(methodology_version) > 0),
  policy_id TEXT CHECK (policy_id IS NULL OR length(policy_id) > 0),
  policy_digest TEXT CHECK (policy_digest IS NULL OR length(policy_digest) = 64),
  evaluation_build_digest TEXT NOT NULL CHECK (length(evaluation_build_digest) = 64),
  base_input_generation_id TEXT NOT NULL CHECK (
    base_input_generation_id GLOB 'report-cards-input:v1:*'
    AND length(base_input_generation_id) = 86
  ),
  model_publication_generation_id TEXT NOT NULL CHECK (length(model_publication_generation_id) > 0),
  publication_epoch INTEGER NOT NULL DEFAULT 0 CHECK (publication_epoch >= 0),
  transition_kind TEXT NOT NULL CHECK (
    transition_kind IN (
      'initial-baseline',
      'organic-grade-change',
      'methodology-boundary-baseline',
      'rollback-baseline',
      'restoration-baseline'
    )
  ),
  grade TEXT NOT NULL CHECK (grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  prev_grade TEXT CHECK (
    prev_grade IS NULL OR prev_grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')
  ),
  prev_score REAL CHECK (prev_score IS NULL OR (prev_score >= 0 AND prev_score <= 100)),
  legacy_recorded_at INTEGER CHECK (legacy_recorded_at IS NULL OR legacy_recorded_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (model = 'v8' AND policy_id IS NULL AND policy_digest IS NULL)
    OR
    (model = 'v9' AND policy_id IS NOT NULL AND policy_digest IS NOT NULL)
  ),
  CHECK (
    (transition_kind = 'organic-grade-change' AND prev_grade IS NOT NULL)
    OR
    (transition_kind != 'organic-grade-change' AND prev_grade IS NULL AND prev_score IS NULL)
  ),
  CHECK (legacy_recorded_at IS NULL OR legacy_recorded_at = recorded_at),
  CHECK (
    legacy_recorded_at IS NULL
    OR transition_kind IN ('initial-baseline', 'organic-grade-change')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_safety_score_history_v2_legacy_row
  ON safety_score_history_v2(stablecoin_id, legacy_recorded_at)
  WHERE legacy_recorded_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_safety_score_history_v2_coin
  ON safety_score_history_v2(stablecoin_id, recorded_at DESC, history_id DESC);

CREATE INDEX IF NOT EXISTS idx_safety_score_history_v2_recorded_at
  ON safety_score_history_v2(recorded_at DESC, history_id DESC);

CREATE INDEX IF NOT EXISTS idx_safety_score_history_v2_model_generation
  ON safety_score_history_v2(model, model_publication_generation_id, stablecoin_id);
