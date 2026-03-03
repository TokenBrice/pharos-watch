CREATE TABLE IF NOT EXISTS admin_idempotency_keys (
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (action, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_admin_idempotency_created_at
  ON admin_idempotency_keys(created_at DESC);
