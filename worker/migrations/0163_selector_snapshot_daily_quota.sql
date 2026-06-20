-- rollout-safety: backward-compatible
CREATE TABLE IF NOT EXISTS selector_snapshot_daily_quota (
  quota_date TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (quota_date, ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_selector_snapshot_daily_quota_last_seen
  ON selector_snapshot_daily_quota(last_seen_at);
