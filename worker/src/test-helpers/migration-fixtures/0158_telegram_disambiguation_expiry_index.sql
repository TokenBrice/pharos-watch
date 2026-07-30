-- rollout-safety: backward-compatible
-- 0158: Index pending Telegram disambiguation expiry time so the 5-minute
-- cleanup can find old rows without scanning attacker-amplified backlog rows.

CREATE INDEX IF NOT EXISTS idx_telegram_pending_disambiguation_expires_at
  ON telegram_pending_disambiguation (expires_at);
