-- rollout-safety: backward-compatible

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started_ok
  ON cron_runs(job, started_at DESC)
  WHERE status = 'ok';
