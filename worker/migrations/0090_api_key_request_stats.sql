-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS api_key_request_stats (
  api_key_id INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_api_key_request_stats_bucket
  ON api_key_request_stats(bucket_start);
