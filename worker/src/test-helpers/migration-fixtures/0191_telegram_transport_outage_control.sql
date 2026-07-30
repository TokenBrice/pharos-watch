-- rollout-safety: backward-compatible
-- Add a durable, generation-fenced Telegram transport circuit and independent
-- expiring delivery-mode pauses. Failure observations are bounded runtime state,
-- not a delivery ledger, and are pruned after the short outage-detection window.

CREATE TABLE IF NOT EXISTS telegram_transport_circuit (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  state TEXT NOT NULL DEFAULT 'closed'
    CHECK (state IN ('closed', 'open', 'half_open')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  cause_class TEXT,
  cause_scope TEXT
    CHECK (cause_scope IS NULL OR cause_scope IN ('fatal', 'transient', 'rate_limit')),
  distinct_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (distinct_failure_count >= 0),
  first_failure_at INTEGER,
  last_failure_at INTEGER,
  last_success_at INTEGER,
  opened_at INTEGER,
  next_probe_at INTEGER,
  probe_owner TEXT CHECK (probe_owner IS NULL OR length(probe_owner) BETWEEN 1 AND 200),
  probe_generation INTEGER CHECK (probe_generation IS NULL OR probe_generation >= 0),
  probe_expires_at INTEGER,
  probe_limit INTEGER CHECK (probe_limit IS NULL OR probe_limit BETWEEN 1 AND 4),
  probe_attempted INTEGER NOT NULL DEFAULT 0 CHECK (probe_attempted BETWEEN 0 AND 4),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO telegram_transport_circuit (
  singleton_id, state, generation, distinct_failure_count, probe_attempted, updated_at
) VALUES (1, 'closed', 0, 0, 0, 0);

CREATE TABLE IF NOT EXISTS telegram_transport_failure_observations (
  failure_scope TEXT NOT NULL
    CHECK (failure_scope IN ('transient', 'rate_limit')),
  chat_id TEXT NOT NULL,
  error_class TEXT NOT NULL CHECK (length(error_class) BETWEEN 1 AND 80),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (failure_scope, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_ttfo_retention
  ON telegram_transport_failure_observations(observed_at);

CREATE TABLE IF NOT EXISTS telegram_delivery_pauses (
  mode TEXT PRIMARY KEY CHECK (mode IN ('fresh', 'pending', 'admin')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  expires_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 320),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tdp_expiry
  ON telegram_delivery_pauses(expires_at);
