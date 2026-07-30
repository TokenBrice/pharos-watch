-- rollout-safety: backward-compatible
-- Persist Telegram source events before subscriber resolution, retain resumable
-- preset-resolution pages as normalized rows, and link delivery targets to the
-- individual source items they cover.

CREATE TABLE IF NOT EXISTS telegram_alert_source_events (
  source_event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'resolving'
    CHECK (status IN ('resolving', 'planned', 'baseline_committed', 'complete', 'expired')),
  detected_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  event_payload TEXT NOT NULL,
  baseline_payload TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_error_class TEXT,
  baseline_committed_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tase_resume
  ON telegram_alert_source_events(status, detected_at)
  WHERE status IN ('resolving', 'planned', 'baseline_committed');

CREATE TABLE IF NOT EXISTS telegram_alert_source_resolution_pages (
  source_event_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('dews', 'depeg', 'safety')),
  page_index INTEGER NOT NULL,
  cursor_chat_id TEXT,
  cursor_preset_id TEXT,
  memberships_resolved INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'complete', 'expired')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error_class TEXT,
  PRIMARY KEY (source_event_id, page_key)
);

CREATE INDEX IF NOT EXISTS idx_tasrp_resume
  ON telegram_alert_source_resolution_pages(source_event_id, status, alert_type, page_index);

CREATE TABLE IF NOT EXISTS telegram_alert_source_resolution_memberships (
  source_event_id TEXT NOT NULL,
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('dews', 'depeg', 'safety')),
  preset_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_event_id, alert_type, preset_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_tasrm_source_preset
  ON telegram_alert_source_resolution_memberships(source_event_id, alert_type, preset_id);

CREATE TABLE IF NOT EXISTS telegram_alert_source_resolution_targets (
  source_event_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_event_id, page_key, preset_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_tasrt_source_page
  ON telegram_alert_source_resolution_targets(source_event_id, page_key, preset_id);

CREATE INDEX IF NOT EXISTS idx_tasrt_chat
  ON telegram_alert_source_resolution_targets(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_alert_job_target_items (
  job_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, target_key, item_key)
);

CREATE INDEX IF NOT EXISTS idx_tajti_source_item
  ON telegram_alert_job_target_items(source_event_id, item_key, job_id, target_key);
