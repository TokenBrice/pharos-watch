-- rollout-safety: backward-compatible
-- Add selected Safety Score v9 replay artifacts and one compact shadow summary
-- per UTC day. Attempt-level diagnostics remain in the existing cron ledger.

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

CREATE TABLE IF NOT EXISTS safety_score_v9_shadow_daily (
  utc_day TEXT PRIMARY KEY,
  updated_at_sec INTEGER NOT NULL CHECK (updated_at_sec >= 0),
  successful_attempt_count INTEGER NOT NULL CHECK (successful_attempt_count >= 0),
  failed_attempt_count INTEGER NOT NULL CHECK (failed_attempt_count >= 0),
  selected_run_at_sec INTEGER CHECK (selected_run_at_sec >= 0),
  publication_generation_id TEXT,
  base_input_generation_id TEXT,
  fact_set_digest TEXT CHECK (fact_set_digest IS NULL OR length(fact_set_digest) = 64),
  policy_digest TEXT CHECK (policy_digest IS NULL OR length(policy_digest) = 64),
  evaluation_build_digest TEXT CHECK (
    evaluation_build_digest IS NULL OR length(evaluation_build_digest) = 64
  ),
  producer_capability_digest TEXT CHECK (
    producer_capability_digest IS NULL OR length(producer_capability_digest) = 64
  ),
  release_coverage_policy_digest TEXT CHECK (
    release_coverage_policy_digest IS NULL OR length(release_coverage_policy_digest) = 64
  ),
  consumer_threshold_registry_digest TEXT CHECK (
    consumer_threshold_registry_digest IS NULL OR length(consumer_threshold_registry_digest) = 64
  ),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  diff_report_digest TEXT CHECK (diff_report_digest IS NULL OR length(diff_report_digest) = 64),
  active_asset_count INTEGER CHECK (active_asset_count IS NULL OR active_asset_count >= 0),
  rateable_count INTEGER CHECK (rateable_count IS NULL OR rateable_count >= 0),
  nr_count INTEGER CHECK (nr_count IS NULL OR nr_count >= 0),
  present_active_count INTEGER CHECK (present_active_count IS NULL OR present_active_count >= 0),
  missing_active_count INTEGER CHECK (missing_active_count IS NULL OR missing_active_count >= 0),
  unexpected_active_count INTEGER CHECK (unexpected_active_count IS NULL OR unexpected_active_count >= 0),
  duplicate_active_count INTEGER CHECK (duplicate_active_count IS NULL OR duplicate_active_count >= 0),
  grade_nr_transition_count INTEGER CHECK (
    grade_nr_transition_count IS NULL OR grade_nr_transition_count >= 0
  ),
  large_score_movement_count INTEGER CHECK (
    large_score_movement_count IS NULL OR large_score_movement_count >= 0
  ),
  top_cutoff_movement_count INTEGER CHECK (
    top_cutoff_movement_count IS NULL OR top_cutoff_movement_count >= 0
  ),
  binding_cap_change_count INTEGER CHECK (
    binding_cap_change_count IS NULL OR binding_cap_change_count >= 0
  ),
  downstream_crossing_count INTEGER CHECK (
    downstream_crossing_count IS NULL OR downstream_crossing_count >= 0
  ),
  unresolved_review_count INTEGER CHECK (
    unresolved_review_count IS NULL OR unresolved_review_count >= 0
  ),
  qualifying INTEGER NOT NULL DEFAULT 0 CHECK (qualifying IN (0, 1)),
  blockers_json TEXT NOT NULL DEFAULT '[]',
  archive_selection_reasons_json TEXT NOT NULL DEFAULT '[]',
  latest_error_code TEXT CHECK (latest_error_code IS NULL OR length(latest_error_code) <= 160),
  latest_error_message TEXT CHECK (latest_error_message IS NULL OR length(latest_error_message) <= 500),
  daily_json TEXT NOT NULL,
  CHECK (successful_attempt_count + failed_attempt_count > 0),
  CHECK (
    (successful_attempt_count = 0 AND selected_run_at_sec IS NULL) OR
    (successful_attempt_count > 0 AND selected_run_at_sec IS NOT NULL)
  ),
  CHECK (
    selected_run_at_sec IS NULL OR (
      publication_generation_id IS NOT NULL AND
      base_input_generation_id IS NOT NULL AND
      fact_set_digest IS NOT NULL AND
      policy_digest IS NOT NULL AND
      evaluation_build_digest IS NOT NULL AND
      producer_capability_digest IS NOT NULL AND
      release_coverage_policy_digest IS NOT NULL AND
      consumer_threshold_registry_digest IS NOT NULL AND
      result_digest IS NOT NULL AND
      diff_report_digest IS NOT NULL AND
      active_asset_count IS NOT NULL AND
      rateable_count IS NOT NULL AND
      nr_count IS NOT NULL AND
      present_active_count IS NOT NULL AND
      missing_active_count IS NOT NULL AND
      unexpected_active_count IS NOT NULL AND
      duplicate_active_count IS NOT NULL AND
      grade_nr_transition_count IS NOT NULL AND
      large_score_movement_count IS NOT NULL AND
      top_cutoff_movement_count IS NOT NULL AND
      binding_cap_change_count IS NOT NULL AND
      downstream_crossing_count IS NOT NULL AND
      unresolved_review_count IS NOT NULL
    )
  ),
  CHECK (
    (latest_error_code IS NULL AND latest_error_message IS NULL) OR
    (latest_error_code IS NOT NULL AND latest_error_message IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_shadow_daily_identity
  ON safety_score_v9_shadow_daily(
    policy_digest,
    evaluation_build_digest,
    producer_capability_digest,
    release_coverage_policy_digest,
    consumer_threshold_registry_digest,
    utc_day
  );
