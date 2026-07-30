-- rollout-safety: backward-compatible
-- Retry-safe Telegram webhook idempotency. Rows are claimed as processing
-- before command handling, then marked processed only after the handler
-- succeeds or returns a terminal handled failure.

CREATE TABLE IF NOT EXISTS telegram_processed_updates (
  update_id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  update_type TEXT,
  chat_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'processed', 'failed')),
  error_class TEXT
);

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_received_at
  ON telegram_processed_updates (received_at);

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_status_received_at
  ON telegram_processed_updates (status, received_at);
