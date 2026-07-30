-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS api_key_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deactivated', 'rotated')),
  actor TEXT NOT NULL DEFAULT 'admin',
  detail_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_log_key
  ON api_key_audit_log(api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_log_recent
  ON api_key_audit_log(created_at DESC);
