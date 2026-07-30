-- rollout-safety: backward-compatible
CREATE TABLE IF NOT EXISTS telegram_adoption_client_quota (
  bucket_start INTEGER NOT NULL,
  ip_hash TEXT NOT NULL CHECK (length(ip_hash) = 32),
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bucket_start, ip_hash)
);
