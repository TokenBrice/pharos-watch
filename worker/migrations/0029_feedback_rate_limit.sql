-- Rate limiting for /api/feedback endpoint
-- Stores hashed IPs with timestamps; pruned hourly by the feedback handler.
CREATE TABLE IF NOT EXISTS feedback_rate_limit (
  ip_hash      TEXT    NOT NULL,
  submitted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_rate_limit_ip
  ON feedback_rate_limit(ip_hash, submitted_at);
