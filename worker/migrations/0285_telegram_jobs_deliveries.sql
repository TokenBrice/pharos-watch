-- rollout-safety: backward-compatible
-- Telegram delivery v2: one job table and one per-chat delivery table.
-- Additive only. The old Worker never reads or writes these tables; the legacy
-- telegram_* delivery tables stay untouched until a separate cleanup rollout.
-- `kind` is TEXT validated by the Worker so new job kinds need no rebuild.
CREATE TABLE IF NOT EXISTS telegram_jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planning', 'ready', 'done', 'cancelled')),
  cursor TEXT,
  planned_count INTEGER NOT NULL DEFAULT 0 CHECK (planned_count >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_telegram_jobs_open
  ON telegram_jobs(state, created_at)
  WHERE state IN ('planning', 'ready');

CREATE INDEX IF NOT EXISTS idx_telegram_jobs_completed
  ON telegram_jobs(completed_at)
  WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_deliveries (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  audience TEXT NOT NULL DEFAULT 'alert'
    CHECK (audience IN ('alert', 'notice', 'channel')),
  method TEXT NOT NULL DEFAULT 'sendMessage'
    CHECK (method IN ('sendMessage', 'sendPhoto')),
  body TEXT,
  body_hash TEXT NOT NULL,
  options_json TEXT,
  coin_ids TEXT,
  families TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'retry', 'sending', 'sent', 'failed', 'blocked',
    'expired', 'cancelled', 'unknown', 'suppressed_duplicate'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claim_owner TEXT,
  claim_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  sending_at INTEGER,
  done_at INTEGER,
  error_class TEXT,
  status_code INTEGER,
  reason TEXT,
  UNIQUE (job_id, chat_id, seq)
);

-- Matches the drain claim: open rows ordered by priority, then job and chat
-- chunk order (next_attempt_at is a residual filter).
CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_due
  ON telegram_deliveries(priority, created_at, job_id, chat_id, seq)
  WHERE state IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_sending
  ON telegram_deliveries(claim_expires_at)
  WHERE state = 'sending';

CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_chat
  ON telegram_deliveries(chat_id, body_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_done
  ON telegram_deliveries(done_at)
  WHERE done_at IS NOT NULL;
