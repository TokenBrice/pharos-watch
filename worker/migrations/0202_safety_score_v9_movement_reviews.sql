-- rollout-safety: backward-compatible
-- Append-only human classifications for material V8-to-V9 movements. Reviews
-- are keyed by a semantic movement fingerprint, so changed score inputs or
-- methodology require a new review while identical movements can be reused.

CREATE TABLE IF NOT EXISTS safety_score_v9_movement_reviews (
  review_key TEXT PRIMARY KEY CHECK (length(review_key) = 64),
  asset_id TEXT NOT NULL,
  source_diff_report_digest TEXT NOT NULL CHECK (length(source_diff_report_digest) = 64),
  candidate_id TEXT NOT NULL,
  source_publication_generation_id TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  evaluation_build_digest TEXT NOT NULL CHECK (length(evaluation_build_digest) = 64),
  v8_methodology_version TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (
    disposition IN ('intended-methodology-change', 'evidence-correction', 'producer-data-gap', 'defect')
  ),
  reviewer_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  reviewed_at_sec INTEGER NOT NULL CHECK (reviewed_at_sec >= 0),
  review_digest TEXT NOT NULL CHECK (length(review_digest) = 64),
  review_json TEXT NOT NULL,
  UNIQUE (source_diff_report_digest, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_movement_reviews_source
  ON safety_score_v9_movement_reviews(source_diff_report_digest, asset_id);

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_movement_reviews_candidate
  ON safety_score_v9_movement_reviews(candidate_id, policy_digest, evaluation_build_digest, reviewed_at_sec DESC);
