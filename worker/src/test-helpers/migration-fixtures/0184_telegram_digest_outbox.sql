-- rollout-safety: backward-compatible
-- Persist immutable Telegram digest editions before delivery and fence each
-- Bot API effect so retries never regenerate copy or replay ambiguous sends.

CREATE TABLE IF NOT EXISTS telegram_digest_outbox (
  edition_key TEXT PRIMARY KEY,
  digest_kind TEXT NOT NULL CHECK (digest_kind IN ('daily', 'weekly')),
  digest_generated_at INTEGER NOT NULL,
  target_chat_id TEXT NOT NULL,
  payload_chunks_json TEXT NOT NULL CHECK (
    json_valid(payload_chunks_json) AND json_type(payload_chunks_json) = 'array'
  ),
  success_actions_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(success_actions_json) AND json_type(success_actions_json) = 'array'
  ),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'sending', 'sent', 'execution_unknown', 'failed_permanent')
  ),
  next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_index >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  delivery_owner TEXT,
  delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0),
  delivery_claimed_at INTEGER,
  delivery_started_at INTEGER,
  delivery_completed_at INTEGER,
  delivery_claim_expires_at INTEGER,
  last_error_class TEXT,
  last_status_code INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_digest_outbox_due
  ON telegram_digest_outbox(state, next_attempt_at, created_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_telegram_digest_outbox_sending
  ON telegram_digest_outbox(state, delivery_claim_expires_at)
  WHERE state = 'sending';

CREATE INDEX IF NOT EXISTS idx_telegram_digest_outbox_terminal
  ON telegram_digest_outbox(state, updated_at DESC)
  WHERE state IN ('execution_unknown', 'failed_permanent');
