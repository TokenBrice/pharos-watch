-- rollout-safety: backward-compatible
-- Persist alert condition state and transition delivery attempts so missing
-- webhooks, failed sends, duplicate producers, and recoveries remain visible.

CREATE TABLE IF NOT EXISTS alert_broker_conditions (
  condition_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'recovered')),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'status', 'alert')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  generation INTEGER NOT NULL DEFAULT 1,
  episode INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  activated_at INTEGER,
  recovered_at INTEGER,
  cooldown_until INTEGER,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  recovery_title TEXT,
  recovery_message TEXT,
  metadata_json TEXT,
  last_transition TEXT CHECK (last_transition IS NULL OR last_transition IN ('incident', 'recovery')),
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_broker_conditions_state_updated
  ON alert_broker_conditions(state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_broker_conditions_mode_state
  ON alert_broker_conditions(mode, state, severity);

CREATE TABLE IF NOT EXISTS alert_broker_deliveries (
  delivery_id TEXT PRIMARY KEY,
  condition_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  episode INTEGER NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('incident', 'recovery')),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'delivering', 'delivered', 'failed', 'missing_target', 'shadow', 'status_only')
  ),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'status', 'alert')),
  target_class TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  delivery_owner TEXT,
  delivery_lease_until INTEGER,
  created_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  delivered_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(condition_key, episode, transition),
  FOREIGN KEY (condition_key) REFERENCES alert_broker_conditions(condition_key)
);

CREATE INDEX IF NOT EXISTS idx_alert_broker_deliveries_retry
  ON alert_broker_deliveries(state, next_attempt_at, delivery_lease_until, created_at);

CREATE INDEX IF NOT EXISTS idx_alert_broker_deliveries_condition_created
  ON alert_broker_deliveries(condition_key, created_at DESC);
