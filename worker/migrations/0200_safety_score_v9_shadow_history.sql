-- rollout-safety: backward-compatible
-- Add immutable Safety Score v9 replay artifacts, complete shadow-attempt
-- accounting, canonical daily summaries, and a fenced model-selection row.

CREATE TABLE IF NOT EXISTS safety_score_v9_artifacts (
  artifact_key TEXT PRIMARY KEY,
  artifact_kind TEXT NOT NULL CHECK (
    artifact_kind IN ('base-input', 'fact-set', 'policy', 'evaluation-build', 'result')
  ),
  identity TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  encoding TEXT NOT NULL CHECK (encoding = 'gzip-base64'),
  uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes > 0),
  stored_bytes INTEGER NOT NULL CHECK (stored_bytes > 0),
  payload TEXT NOT NULL,
  created_at_sec INTEGER NOT NULL CHECK (created_at_sec >= 0),
  verified_at_sec INTEGER NOT NULL CHECK (verified_at_sec >= created_at_sec),
  UNIQUE (artifact_kind, identity),
  CHECK (artifact_key = artifact_kind || ':' || content_sha256)
);

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_artifacts_created
  ON safety_score_v9_artifacts(created_at_sec DESC);

CREATE TABLE IF NOT EXISTS safety_score_v9_shadow_attempts (
  attempt_id TEXT PRIMARY KEY,
  utc_day TEXT NOT NULL,
  scheduled_for_sec INTEGER NOT NULL CHECK (scheduled_for_sec >= 0),
  started_at_sec INTEGER,
  completed_at_sec INTEGER,
  recorded_at_sec INTEGER NOT NULL CHECK (recorded_at_sec >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('missed', 'aborted', 'failed', 'succeeded')),
  qualifying INTEGER NOT NULL DEFAULT 0 CHECK (qualifying IN (0, 1)),
  publication_generation_id TEXT,
  base_input_generation_id TEXT,
  fact_set_digest TEXT,
  policy_digest TEXT,
  evaluation_build_digest TEXT,
  producer_capability_digest TEXT,
  envelope_digest TEXT,
  attempt_json TEXT NOT NULL,
  CHECK (started_at_sec IS NULL OR started_at_sec >= 0),
  CHECK (completed_at_sec IS NULL OR completed_at_sec >= 0),
  CHECK (completed_at_sec IS NULL OR started_at_sec IS NULL OR completed_at_sec >= started_at_sec)
);

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_shadow_attempts_day
  ON safety_score_v9_shadow_attempts(utc_day, scheduled_for_sec, attempt_id);

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_shadow_attempts_identity
  ON safety_score_v9_shadow_attempts(policy_digest, evaluation_build_digest, producer_capability_digest, utc_day);

CREATE TABLE IF NOT EXISTS safety_score_v9_shadow_days (
  utc_day TEXT PRIMARY KEY,
  canonical_attempt_id TEXT,
  qualifying INTEGER NOT NULL DEFAULT 0 CHECK (qualifying IN (0, 1)),
  expected_attempt_count INTEGER NOT NULL CHECK (expected_attempt_count >= 0),
  recorded_attempt_count INTEGER NOT NULL CHECK (recorded_attempt_count >= 0),
  policy_digest TEXT,
  evaluation_build_digest TEXT,
  producer_capability_digest TEXT,
  day_json TEXT NOT NULL,
  updated_at_sec INTEGER NOT NULL CHECK (updated_at_sec >= 0),
  FOREIGN KEY (canonical_attempt_id) REFERENCES safety_score_v9_shadow_attempts(attempt_id)
);

CREATE TABLE IF NOT EXISTS safety_score_publication_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  transition_epoch INTEGER NOT NULL CHECK (transition_epoch >= 0),
  state TEXT NOT NULL CHECK (
    state IN ('v8-active-v9-shadow', 'v9-active-v8-warm', 'v8-restored-v9-retained')
  ),
  active_model TEXT NOT NULL CHECK (active_model IN ('v8', 'v9')),
  active_generation_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  updated_at_sec INTEGER NOT NULL CHECK (updated_at_sec >= 0)
);
