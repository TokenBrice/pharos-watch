-- rollout-safety: backward-compatible
-- data-migration: reviewed
-- Record privacy-preserving daily watcher transitions independently from aggregate snapshots.
-- Existing subscribers are initialized without emitting historical events; subsequent mutations
-- update the daily counters atomically with the subscription change.
ALTER TABLE telegram_subscribers ADD COLUMN watcher_active INTEGER NOT NULL DEFAULT 0 CHECK (watcher_active IN (0, 1));
ALTER TABLE telegram_subscribers ADD COLUMN watcher_ever_active INTEGER NOT NULL DEFAULT 0 CHECK (watcher_ever_active IN (0, 1));

CREATE TABLE telegram_watcher_lifecycle_events_daily (
  day TEXT PRIMARY KEY,
  subscribe_events INTEGER NOT NULL DEFAULT 0 CHECK (subscribe_events >= 0),
  unsubscribe_events INTEGER NOT NULL DEFAULT 0 CHECK (unsubscribe_events >= 0),
  reactivate_events INTEGER NOT NULL DEFAULT 0 CHECK (reactivate_events >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

UPDATE telegram_subscribers
   SET watcher_active = CASE WHEN
     global_alert_dews = 1 OR global_alert_depeg = 1 OR global_alert_safety = 1
     OR global_alert_launch = 1 OR global_alert_reserve = 1 OR global_alert_freeze = 1
     OR EXISTS (
       SELECT 1 FROM telegram_subscriptions sub
        WHERE sub.chat_id = telegram_subscribers.chat_id
          AND (sub.alert_dews = 1 OR sub.alert_depeg = 1 OR sub.alert_safety = 1
            OR sub.alert_launch = 1 OR sub.alert_reserve = 1 OR sub.alert_freeze = 1)
     )
     OR EXISTS (
       SELECT 1 FROM telegram_preset_subscriptions preset
        WHERE preset.chat_id = telegram_subscribers.chat_id
          AND (preset.alert_dews = 1 OR preset.alert_depeg = 1 OR preset.alert_safety = 1)
     )
   THEN 1 ELSE 0 END,
       watcher_ever_active = 1;

CREATE TRIGGER trg_telegram_watcher_subscriber_insert
AFTER INSERT ON telegram_subscribers
WHEN NEW.global_alert_dews = 1 OR NEW.global_alert_depeg = 1 OR NEW.global_alert_safety = 1
  OR NEW.global_alert_launch = 1 OR NEW.global_alert_reserve = 1 OR NEW.global_alert_freeze = 1
BEGIN
  INSERT INTO telegram_watcher_lifecycle_events_daily (day, subscribe_events, updated_at)
  VALUES (date('now'), 1, unixepoch())
  ON CONFLICT(day) DO UPDATE SET
    subscribe_events = subscribe_events + 1,
    updated_at = excluded.updated_at;
  UPDATE telegram_subscribers
     SET watcher_active = 1, watcher_ever_active = 1
   WHERE chat_id = NEW.chat_id;
END;

CREATE TRIGGER trg_telegram_watcher_subscriber_update
AFTER UPDATE OF global_alert_dews, global_alert_depeg, global_alert_safety,
  global_alert_launch, global_alert_reserve, global_alert_freeze ON telegram_subscribers
BEGIN
  INSERT INTO telegram_watcher_lifecycle_events_daily (
    day, subscribe_events, unsubscribe_events, reactivate_events, updated_at
  )
  SELECT date('now'),
         CASE WHEN active = 1 AND watcher_ever_active = 0 THEN 1 ELSE 0 END,
         CASE WHEN active = 0 THEN 1 ELSE 0 END,
         CASE WHEN active = 1 AND watcher_ever_active = 1 THEN 1 ELSE 0 END,
         unixepoch()
    FROM (
      SELECT watcher_active, watcher_ever_active,
             CASE WHEN
               global_alert_dews = 1 OR global_alert_depeg = 1 OR global_alert_safety = 1
               OR global_alert_launch = 1 OR global_alert_reserve = 1 OR global_alert_freeze = 1
               OR EXISTS (SELECT 1 FROM telegram_subscriptions sub WHERE sub.chat_id = NEW.chat_id
                 AND (sub.alert_dews = 1 OR sub.alert_depeg = 1 OR sub.alert_safety = 1
                   OR sub.alert_launch = 1 OR sub.alert_reserve = 1 OR sub.alert_freeze = 1))
               OR EXISTS (SELECT 1 FROM telegram_preset_subscriptions preset WHERE preset.chat_id = NEW.chat_id
                 AND (preset.alert_dews = 1 OR preset.alert_depeg = 1 OR preset.alert_safety = 1))
             THEN 1 ELSE 0 END AS active
        FROM telegram_subscribers WHERE chat_id = NEW.chat_id
    )
   WHERE active <> watcher_active
  ON CONFLICT(day) DO UPDATE SET
    subscribe_events = subscribe_events + excluded.subscribe_events,
    unsubscribe_events = unsubscribe_events + excluded.unsubscribe_events,
    reactivate_events = reactivate_events + excluded.reactivate_events,
    updated_at = excluded.updated_at;
  UPDATE telegram_subscribers
     SET watcher_active = CASE WHEN
       global_alert_dews = 1 OR global_alert_depeg = 1 OR global_alert_safety = 1
       OR global_alert_launch = 1 OR global_alert_reserve = 1 OR global_alert_freeze = 1
       OR EXISTS (SELECT 1 FROM telegram_subscriptions sub WHERE sub.chat_id = NEW.chat_id
         AND (sub.alert_dews = 1 OR sub.alert_depeg = 1 OR sub.alert_safety = 1
           OR sub.alert_launch = 1 OR sub.alert_reserve = 1 OR sub.alert_freeze = 1))
       OR EXISTS (SELECT 1 FROM telegram_preset_subscriptions preset WHERE preset.chat_id = NEW.chat_id
         AND (preset.alert_dews = 1 OR preset.alert_depeg = 1 OR preset.alert_safety = 1))
     THEN 1 ELSE 0 END,
         watcher_ever_active = MAX(watcher_ever_active, watcher_active)
   WHERE chat_id = NEW.chat_id;
END;

CREATE TRIGGER trg_telegram_watcher_subscriber_delete
BEFORE DELETE ON telegram_subscribers
WHEN OLD.watcher_active = 1
BEGIN
  INSERT INTO telegram_watcher_lifecycle_events_daily (day, unsubscribe_events, updated_at)
  VALUES (date('now'), 1, unixepoch())
  ON CONFLICT(day) DO UPDATE SET
    unsubscribe_events = unsubscribe_events + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_telegram_watcher_subscription_insert
AFTER INSERT ON telegram_subscriptions
BEGIN
  UPDATE telegram_subscribers
     SET global_alert_dews = global_alert_dews
   WHERE chat_id = NEW.chat_id;
END;

CREATE TRIGGER trg_telegram_watcher_subscription_update
AFTER UPDATE OF alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, alert_freeze ON telegram_subscriptions
BEGIN
  UPDATE telegram_subscribers
     SET global_alert_dews = global_alert_dews
   WHERE chat_id = NEW.chat_id;
END;

CREATE TRIGGER trg_telegram_watcher_subscription_delete
AFTER DELETE ON telegram_subscriptions
BEGIN
  UPDATE telegram_subscribers
     SET global_alert_dews = global_alert_dews
   WHERE chat_id = OLD.chat_id;
END;

CREATE TRIGGER trg_telegram_watcher_preset_insert
AFTER INSERT ON telegram_preset_subscriptions
BEGIN
  UPDATE telegram_subscribers
     SET global_alert_dews = global_alert_dews
   WHERE chat_id = NEW.chat_id;
END;

CREATE TRIGGER trg_telegram_watcher_preset_update
AFTER UPDATE OF alert_dews, alert_depeg, alert_safety ON telegram_preset_subscriptions
BEGIN
  UPDATE telegram_subscribers
     SET global_alert_dews = global_alert_dews
   WHERE chat_id = NEW.chat_id;
END;

CREATE TRIGGER trg_telegram_watcher_preset_delete
AFTER DELETE ON telegram_preset_subscriptions
BEGIN
  UPDATE telegram_subscribers
     SET global_alert_dews = global_alert_dews
   WHERE chat_id = OLD.chat_id;
END;
