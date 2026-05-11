-- rollout-safety: backward-compatible
-- Track consecutive 403 (blocked) responses per Telegram subscriber so the
-- pending-queue dispatcher can apply a two-strike rule before zeroing all
-- alert flags. A single 403 is treated as transient; only two strikes within
-- 24h trigger the aggressive cascade. Successful sends reset both columns.

ALTER TABLE telegram_subscribers ADD COLUMN consecutive_block_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscribers ADD COLUMN consecutive_block_first_at INTEGER;
