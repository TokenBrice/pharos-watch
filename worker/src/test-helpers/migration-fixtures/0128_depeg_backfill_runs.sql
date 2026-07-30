-- rollout-safety: backward-compatible
CREATE TABLE IF NOT EXISTS depeg_backfill_runs (
  run_id TEXT PRIMARY KEY,
  stablecoin_id TEXT NOT NULL,
  start_day INTEGER,
  end_day INTEGER,
  context_days INTEGER,
  source_type TEXT NOT NULL,
  expected_event_count INTEGER NOT NULL DEFAULT 0,
  expected_fingerprint TEXT NOT NULL,
  removed_count INTEGER NOT NULL DEFAULT 0,
  added_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_depeg_backfill_runs_status
  ON depeg_backfill_runs(status, started_at);

CREATE INDEX IF NOT EXISTS idx_depeg_backfill_runs_stablecoin
  ON depeg_backfill_runs(stablecoin_id, started_at DESC);
