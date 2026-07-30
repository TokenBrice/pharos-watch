-- rollout-safety: backward-compatible
-- Add only residual indexes justified by the July 2026 D1 Insights capture.

CREATE INDEX IF NOT EXISTS idx_cron_runs_started_job_id
  ON cron_runs(started_at DESC, job, id DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_chain_id_page
  ON blacklist_events(chain_id, timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_yield_source_decisions_created_coin
  ON yield_source_decisions(created_at ASC, stablecoin_id ASC);
