-- Tightens Telegram subscription controls and pending command handling.
-- Adds per-subscription alert preferences, quiet-hours support, and
-- generic pending-action metadata for disambiguation flows.

ALTER TABLE telegram_subscriptions ADD COLUMN alert_dews INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscriptions ADD COLUMN alert_depeg INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscriptions ADD COLUMN alert_safety INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_subscriptions ADD COLUMN dews_min_band TEXT;
ALTER TABLE telegram_subscriptions ADD COLUMN safety_mode TEXT;
ALTER TABLE telegram_subscriptions ADD COLUMN depeg_worsening_bps_step INTEGER;

UPDATE telegram_subscriptions
   SET alert_dews = COALESCE(
         (SELECT s.alert_dews FROM telegram_subscribers s WHERE s.chat_id = telegram_subscriptions.chat_id),
         0
       ),
       alert_depeg = COALESCE(
         (SELECT s.alert_depeg FROM telegram_subscribers s WHERE s.chat_id = telegram_subscriptions.chat_id),
         0
       ),
       alert_safety = COALESCE(
         (SELECT s.alert_safety FROM telegram_subscribers s WHERE s.chat_id = telegram_subscriptions.chat_id),
         0
       );

ALTER TABLE telegram_subscribers ADD COLUMN quiet_hours_start_utc INTEGER;
ALTER TABLE telegram_subscribers ADD COLUMN quiet_hours_end_utc INTEGER;
ALTER TABLE telegram_subscribers ADD COLUMN quiet_hours_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE telegram_pending_disambiguation ADD COLUMN action_type TEXT NOT NULL DEFAULT 'subscribe';
ALTER TABLE telegram_pending_disambiguation ADD COLUMN action_payload TEXT NOT NULL DEFAULT '{}';
