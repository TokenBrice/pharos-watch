-- rollout-safety: backward-compatible
-- Durable, idempotent evidence for guarded blacklist reconciliation and
-- bounded provider/repair maintenance. Existing Worker versions ignore every
-- additive column and table while the new version is being promoted.

ALTER TABLE blacklist_events ADD COLUMN reconciliation_manifest_id TEXT;
ALTER TABLE blacklist_events ADD COLUMN reconciliation_run_id TEXT;
ALTER TABLE blacklist_events ADD COLUMN provenance_source TEXT;
ALTER TABLE blacklist_events ADD COLUMN provenance_observed_at INTEGER;
ALTER TABLE blacklist_events ADD COLUMN source_event_index INTEGER;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_reconciliation_manifest
  ON blacklist_events(reconciliation_manifest_id, id);

CREATE TABLE IF NOT EXISTS blacklist_reconciliation_runs (
  run_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'apply')),
  status TEXT NOT NULL CHECK (status IN ('running', 'verified', 'failed')),
  time_travel_bookmark TEXT,
  expected_event_count INTEGER NOT NULL,
  upstream_event_count INTEGER NOT NULL,
  present_event_count INTEGER NOT NULL DEFAULT 0,
  inserted_event_count INTEGER NOT NULL DEFAULT 0,
  missing_event_count INTEGER NOT NULL DEFAULT 0,
  duplicate_identity_count INTEGER NOT NULL DEFAULT 0,
  expected_destroyed_amount_raw INTEGER NOT NULL DEFAULT 0,
  actual_destroyed_amount_raw INTEGER NOT NULL DEFAULT 0,
  balance_replay_expected_count INTEGER NOT NULL DEFAULT 0,
  balance_replay_matching_count INTEGER NOT NULL DEFAULT 0,
  unresolved_manifest_gap_count INTEGER NOT NULL DEFAULT 0,
  tron_cursor_before INTEGER,
  tron_cursor_after INTEGER,
  tron_safe_head INTEGER,
  arbitrum_min_cursor INTEGER,
  arbitrum_min_safe_head INTEGER,
  arbitrum_expected_config_count INTEGER NOT NULL DEFAULT 0,
  arbitrum_at_safe_head_count INTEGER NOT NULL DEFAULT 0,
  verification_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_blacklist_reconciliation_runs_latest
  ON blacklist_reconciliation_runs(started_at DESC, run_id DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_reconciliation_runs_manifest
  ON blacklist_reconciliation_runs(manifest_id, started_at DESC);

CREATE TABLE IF NOT EXISTS blacklist_amount_repair_queue (
  event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry', 'resolved', 'unrecoverable')),
  priority INTEGER NOT NULL DEFAULT 100,
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_expires_at INTEGER,
  last_error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (event_id) REFERENCES blacklist_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blacklist_amount_repair_queue_due
  ON blacklist_amount_repair_queue(status, available_at, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_blacklist_amount_repair_queue_lease
  ON blacklist_amount_repair_queue(status, lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS blacklist_provider_scan_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  provider_mode TEXT NOT NULL,
  coverage_outcome TEXT NOT NULL,
  from_cursor INTEGER NOT NULL,
  scanned_to_cursor INTEGER,
  safe_head INTEGER,
  fetched_row_count INTEGER NOT NULL DEFAULT 0,
  inserted_row_count INTEGER NOT NULL DEFAULT 0,
  provider_call_count INTEGER NOT NULL DEFAULT 0,
  max_split_depth INTEGER NOT NULL DEFAULT 0,
  failure_samples_json TEXT NOT NULL DEFAULT '[]',
  observed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blacklist_provider_scan_telemetry_latest
  ON blacklist_provider_scan_telemetry(observed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_provider_scan_telemetry_config
  ON blacklist_provider_scan_telemetry(config_key, observed_at DESC);
