CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  item_count INTEGER,
  metadata TEXT
);
CREATE INDEX idx_cron_runs_job_started ON cron_runs(job, started_at DESC);
