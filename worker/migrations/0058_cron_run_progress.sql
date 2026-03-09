CREATE TABLE IF NOT EXISTS cron_run_progress (
  job TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stage TEXT,
  items_done INTEGER,
  items_total INTEGER,
  message TEXT,
  lease_owner TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_run_progress_updated_at
  ON cron_run_progress(updated_at DESC);
