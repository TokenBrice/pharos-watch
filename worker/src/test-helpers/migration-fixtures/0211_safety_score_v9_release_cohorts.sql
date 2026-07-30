-- rollout-safety: backward-compatible
-- Frozen V9-9 release cohort records: one owner-ratified cohort per sealed
-- release candidate. The shadow runner re-pins the cohort's identity bindings
-- to each day's exact candidate and evaluates the stored cohort against the
-- current facts; identity or cohort drift fails the ratified-release-coverage
-- floor closed. Older Workers ignore this table entirely.

CREATE TABLE IF NOT EXISTS safety_score_v9_release_cohorts (
  release_candidate_id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  evaluation_build_digest TEXT NOT NULL CHECK (length(evaluation_build_digest) = 64),
  continuing_active_v8_rateable_count INTEGER NOT NULL CHECK (continuing_active_v8_rateable_count >= 0),
  active_asset_count INTEGER NOT NULL CHECK (active_asset_count > 0),
  ratified_by TEXT NOT NULL,
  rationale TEXT NOT NULL,
  ratified_at_sec INTEGER NOT NULL CHECK (ratified_at_sec >= 0),
  cohort_digest TEXT NOT NULL CHECK (length(cohort_digest) = 64),
  cohort_json TEXT NOT NULL,
  UNIQUE (cohort_digest)
);
