-- rollout-safety: backward-compatible
-- Daily "Changes" roll-up storage. telegram_change_log keeps alert changes
-- that are not sent live (minor safety moves, DEWS de-escalations, freezes
-- under the live threshold, reserve drift) plus per-chat cap overflow, for a
-- bounded retention window. telegram_rollup_state records each chat's last
-- roll-up so the next one covers exactly the time since. Additive only.
CREATE TABLE IF NOT EXISTS telegram_change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('safety', 'dews', 'freeze', 'reserve', 'overflow')),
  stablecoin_id TEXT,
  -- Set only for per-chat cap overflow rows.
  chat_id TEXT,
  source_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_change_log_observed
  ON telegram_change_log (observed_at);

CREATE INDEX IF NOT EXISTS idx_telegram_change_log_chat
  ON telegram_change_log (chat_id, observed_at)
  WHERE chat_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_rollup_state (
  chat_id TEXT PRIMARY KEY,
  last_rollup_local_date TEXT NOT NULL,
  last_rollup_at INTEGER NOT NULL
);
