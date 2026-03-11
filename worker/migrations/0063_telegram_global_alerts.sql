-- Adds explicit all-stablecoin alert flags for Telegram subscribers.
-- These are distinct from the legacy subscriber alert flags, which were
-- historically used as broad defaults / summaries for per-coin follows.

ALTER TABLE telegram_subscribers ADD COLUMN global_alert_dews INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscribers ADD COLUMN global_alert_depeg INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscribers ADD COLUMN global_alert_safety INTEGER NOT NULL DEFAULT 0;
