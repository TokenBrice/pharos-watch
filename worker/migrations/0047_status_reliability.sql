CREATE TABLE IF NOT EXISTS status_state (
  scope TEXT PRIMARY KEY,
  current_status TEXT NOT NULL CHECK (current_status IN ('healthy', 'degraded', 'stale')),
  raw_status TEXT NOT NULL CHECK (raw_status IN ('healthy', 'degraded', 'stale')),
  last_evaluated_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  consecutive_healthy INTEGER NOT NULL DEFAULT 0,
  consecutive_degraded INTEGER NOT NULL DEFAULT 0,
  consecutive_stale INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1,
  causes_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  previous_status TEXT CHECK (previous_status IN ('healthy', 'degraded', 'stale')),
  next_status TEXT NOT NULL CHECK (next_status IN ('healthy', 'degraded', 'stale')),
  raw_status TEXT NOT NULL CHECK (raw_status IN ('healthy', 'degraded', 'stale')),
  transition_type TEXT NOT NULL CHECK (transition_type IN ('degrade', 'recover', 'init')),
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  causes_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_transitions_scope_created_at
  ON status_transitions(scope, created_at DESC);

CREATE TABLE IF NOT EXISTS status_probe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_count INTEGER NOT NULL,
  pass_count INTEGER NOT NULL,
  fail_count INTEGER NOT NULL,
  p95_latency_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'stale')),
  details_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_probe_runs_created_at
  ON status_probe_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS status_discrepancy_state (
  scope TEXT PRIMARY KEY,
  consecutive_divergent INTEGER NOT NULL DEFAULT 0,
  last_divergent_at INTEGER,
  last_alert_at INTEGER,
  updated_at INTEGER NOT NULL
);
