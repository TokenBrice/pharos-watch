-- rollout-safety: backward-compatible
-- Bind Telegram pending disambiguation rows to the user who started them.

ALTER TABLE telegram_pending_disambiguation
  ADD COLUMN initiator_user_id TEXT;
