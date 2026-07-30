-- rollout-safety: backward-compatible

ALTER TABLE redemption_backstop ADD COLUMN snapshot_run_id TEXT;
ALTER TABLE redemption_backstop_history ADD COLUMN snapshot_run_id TEXT;

CREATE TABLE IF NOT EXISTS redemption_backstop_runs (
  run_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  expected_count INTEGER NOT NULL,
  written_count INTEGER NOT NULL DEFAULT 0,
  methodology_version TEXT NOT NULL,
  min_updated_at INTEGER,
  max_updated_at INTEGER,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_runs_status_completed
  ON redemption_backstop_runs(status, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_redemption_backstop_snapshot_run_id
  ON redemption_backstop(snapshot_run_id);
CREATE INDEX IF NOT EXISTS idx_redemption_backstop_history_run_id
  ON redemption_backstop_history(snapshot_run_id);
