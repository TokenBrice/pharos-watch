-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS api_request_source_stats (
  bucket_start INTEGER NOT NULL,
  route_key TEXT NOT NULL,
  route_path TEXT NOT NULL,
  source TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, route_key, source)
);

CREATE INDEX IF NOT EXISTS idx_api_request_source_stats_bucket
  ON api_request_source_stats(bucket_start);

CREATE INDEX IF NOT EXISTS idx_api_request_source_stats_route
  ON api_request_source_stats(route_key, bucket_start);
