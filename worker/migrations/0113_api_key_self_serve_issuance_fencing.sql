-- rollout-safety: backward-compatible
-- 0113: Add self-serve issuance lock metadata and fixed-window issuance caps.

ALTER TABLE api_key_requests ADD COLUMN issuance_locked_at INTEGER;

CREATE TABLE IF NOT EXISTS api_key_self_serve_issuance_limits (
  scope TEXT NOT NULL CHECK (scope IN ('submission_ip_daily')),
  subject_hash TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject_hash, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_api_key_self_serve_issuance_limits_bucket
  ON api_key_self_serve_issuance_limits(bucket_start);
