CREATE TABLE IF NOT EXISTS public_api_rate_limit (
  ip_hash TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_public_api_rate_limit_bucket_start
  ON public_api_rate_limit(bucket_start);
