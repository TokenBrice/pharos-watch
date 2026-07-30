-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_prefix TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_email TEXT,
  tier TEXT NOT NULL DEFAULT 'standard',
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 120,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_used_route TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active, created_at DESC);
