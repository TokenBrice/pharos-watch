-- rollout-safety: backward-compatible
-- Add Telegram pending-delivery capacity metadata plus a dead-letter audit path
-- for rows that expire before delivery. These columns let the scheduled sender
-- prioritize risk alerts ahead of low-priority admin broadcasts without adding
-- a new Worker/Queue lane.

ALTER TABLE telegram_pending_alerts ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
ALTER TABLE telegram_pending_alerts ADD COLUMN source_type TEXT NOT NULL DEFAULT 'risk_alert';
ALTER TABLE telegram_pending_alerts ADD COLUMN alert_type TEXT;
ALTER TABLE telegram_pending_alerts ADD COLUMN expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tpa_priority_ready
  ON telegram_pending_alerts(priority, not_before_at, created_at);

CREATE INDEX IF NOT EXISTS idx_tpa_expires_at
  ON telegram_pending_alerts(expires_at);

CREATE TABLE IF NOT EXISTS telegram_alert_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_id INTEGER,
  chat_id TEXT NOT NULL,
  message_html TEXT NOT NULL,
  source_type TEXT,
  alert_type TEXT,
  priority INTEGER,
  created_at INTEGER NOT NULL,
  expired_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_class TEXT,
  reason TEXT NOT NULL,
  dedupe_key TEXT,
  chunk_index INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tadl_expired_at
  ON telegram_alert_dead_letters(expired_at DESC);

CREATE INDEX IF NOT EXISTS idx_tadl_chat_expired
  ON telegram_alert_dead_letters(chat_id, expired_at DESC);

CREATE TABLE IF NOT EXISTS telegram_alert_jobs (
  job_id TEXT PRIMARY KEY,
  alert_type TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered', 'queued', 'sent', 'degraded', 'expired')),
  target_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  enqueued_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_cursor TEXT,
  metadata TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_taj_source_alert
  ON telegram_alert_jobs(source_event_id, alert_type);

CREATE INDEX IF NOT EXISTS idx_taj_status_created
  ON telegram_alert_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS telegram_alert_job_targets (
  job_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  alert_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'queued', 'sent', 'failed', 'expired')),
  pending_dedupe_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  enqueued_at INTEGER,
  failed_at INTEGER,
  error_class TEXT,
  PRIMARY KEY (job_id, target_key)
);

CREATE INDEX IF NOT EXISTS idx_tajt_status_created
  ON telegram_alert_job_targets(status, created_at);

CREATE INDEX IF NOT EXISTS idx_tajt_chat_created
  ON telegram_alert_job_targets(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tajt_pending_dedupe
  ON telegram_alert_job_targets(pending_dedupe_key);
