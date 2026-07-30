-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS api_key_rate_limit (
  api_key_id INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (api_key_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_api_key_rate_limit_bucket ON api_key_rate_limit(bucket_start);
