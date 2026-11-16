-- rollout-safety: backward-compatible
-- Prospective creation attempts only; retained scorecard bodies live in R2.
CREATE TABLE IF NOT EXISTS social_scorecard_daily_quota (
  quota_date TEXT NOT NULL,
  quota_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0 AND count <= 2000),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (quota_date, quota_key)
);
