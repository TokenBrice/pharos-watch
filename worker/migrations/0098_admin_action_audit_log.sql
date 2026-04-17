-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS admin_action_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'error')),
  http_status INTEGER,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_action_audit_created_at
  ON admin_action_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_action_audit_actor_action
  ON admin_action_audit (actor, action, created_at DESC);
