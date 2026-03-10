-- Overflow delivery queue for telegram alert dispatch.
-- Messages that cannot be sent within a single dispatch run are
-- stored here and drained by subsequent runs.
CREATE TABLE IF NOT EXISTS telegram_pending_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  message_html TEXT NOT NULL,
  disable_notification INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_tpa_created ON telegram_pending_alerts(created_at);
