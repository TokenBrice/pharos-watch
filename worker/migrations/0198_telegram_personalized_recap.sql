-- rollout-safety: backward-compatible
-- Additive persistence for the opt-in private-chat personalized daily recap.
-- Recap payloads are owned by telegram_pending_alerts; targets retain only
-- bounded aggregate metadata and the immutable planning window.

CREATE TABLE IF NOT EXISTS telegram_recap_preferences (
  chat_id TEXT PRIMARY KEY,
  -- Captured by the private command/Mini App mutation; group chats cannot
  -- create recap preferences. Existing subscribers default to private for
  -- backward-compatible rollout because no prior durable chat-kind column
  -- exists.
  chat_kind TEXT NOT NULL DEFAULT 'private' CHECK (chat_kind = 'private'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence = 'daily'),
  delivery_hour_local INTEGER NOT NULL DEFAULT 9
    CHECK (delivery_hour_local BETWEEN 0 AND 23),
  next_due_at INTEGER,
  last_window_end_at INTEGER,
  last_delivered_local_date TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_recap_preferences_due
  ON telegram_recap_preferences(enabled, next_due_at, chat_id)
  WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS telegram_recap_targets (
  recap_key TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  tape_high_water_id INTEGER,
  preference_generation INTEGER NOT NULL CHECK (preference_generation >= 0),
  watchlist_fingerprint TEXT NOT NULL,
  payload_hash TEXT,
  material_coin_count INTEGER NOT NULL DEFAULT 0 CHECK (material_coin_count >= 0),
  material_fact_count INTEGER NOT NULL DEFAULT 0 CHECK (material_fact_count >= 0),
  omitted_fact_count INTEGER NOT NULL DEFAULT 0 CHECK (omitted_fact_count >= 0),
  pending_dedupe_key TEXT,
  pending_id INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'skipped_no_changes', 'skipped_paused', 'skipped_stale',
    'planned', 'queued', 'sent', 'cancelled', 'expired',
    'execution_unknown', 'failed_permanent'
  )),
  terminal_reason TEXT,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id, local_date)
);

CREATE INDEX IF NOT EXISTS idx_telegram_recap_targets_status
  ON telegram_recap_targets(status, updated_at, recap_key);

CREATE INDEX IF NOT EXISTS idx_telegram_recap_targets_chat
  ON telegram_recap_targets(chat_id, created_at DESC);
