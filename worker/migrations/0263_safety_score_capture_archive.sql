-- rollout-safety: backward-compatible
-- Exact replay transports live in R2; D1 retains only their discovery/integrity index.
CREATE TABLE IF NOT EXISTS safety_score_capture_archive (
  generation_id TEXT PRIMARY KEY,
  published_at INTEGER NOT NULL,
  methodology_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  evaluation_build_digest TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  object_sha256 TEXT NOT NULL,
  object_bytes INTEGER NOT NULL,
  archived_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_safety_score_capture_archive_published
  ON safety_score_capture_archive(published_at);
