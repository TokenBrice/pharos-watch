-- rollout-safety: backward-compatible
-- Aggregate-only Telegram adoption funnel and retention telemetry. Raw chat
-- identifiers remain in the operational subscriber/cache tables and never
-- enter the analytics rollups.

ALTER TABLE telegram_subscribers ADD COLUMN first_follow_at INTEGER;
ALTER TABLE telegram_subscribers ADD COLUMN first_setup_completed_at INTEGER;

-- Existing watchers predate the funnel. Mark their milestones as historical so
-- the first post-rollout edit cannot masquerade as a new first follow/setup.
UPDATE telegram_subscribers
   SET first_follow_at = last_active_at,
       first_setup_completed_at = created_at
 WHERE global_alert_dews = 1
    OR global_alert_depeg = 1
    OR global_alert_safety = 1
    OR global_alert_launch = 1
    OR global_alert_reserve = 1
    OR EXISTS (
      SELECT 1 FROM telegram_subscriptions t
       WHERE t.chat_id = telegram_subscribers.chat_id
         AND (t.alert_dews = 1 OR t.alert_depeg = 1 OR t.alert_safety = 1 OR t.alert_launch = 1 OR t.alert_reserve = 1)
    )
    OR EXISTS (
      SELECT 1 FROM telegram_preset_subscriptions p
       WHERE p.chat_id = telegram_subscribers.chat_id
         AND (p.alert_dews = 1 OR p.alert_depeg = 1 OR p.alert_safety = 1)
    );

CREATE TABLE IF NOT EXISTS telegram_adoption_daily (
  day TEXT NOT NULL CHECK (length(day) = 10),
  campaign TEXT NOT NULL CHECK (campaign IN ('landing', 'organic')),
  placement TEXT NOT NULL CHECK (
    placement IN ('hero', 'setup', 'miniapp_setup', 'miniapp_home', 'miniapp_watchlist', 'menu', 'unknown')
  ),
  stage TEXT NOT NULL CHECK (
    stage IN ('cta_click', 'bot_start', 'setup_complete', 'first_follow', 'mini_app_session', 'first_mutation')
  ),
  feature TEXT NOT NULL DEFAULT '' CHECK (
    feature IN ('', 'direct', 'preset', 'global', 'recommended_setup', 'coin', 'settings',
      'quiet_hours', 'snooze', 'timezone', 'unsubscribe', 'forget', 'other')
  ),
  latency_bucket TEXT NOT NULL DEFAULT '' CHECK (
    latency_bucket IN ('', 'lt_30s', '30s_2m', '2m_5m', 'gte_5m', 'unknown')
  ),
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'readonly', 'failure')),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day, campaign, placement, stage, feature, latency_bucket, outcome)
);

CREATE INDEX IF NOT EXISTS idx_telegram_adoption_daily_stage_day
  ON telegram_adoption_daily(stage, day);

CREATE TABLE IF NOT EXISTS telegram_adoption_retention_daily (
  cohort_day TEXT NOT NULL CHECK (length(cohort_day) = 10),
  measurement_day TEXT NOT NULL CHECK (length(measurement_day) = 10),
  window_days INTEGER NOT NULL CHECK (window_days IN (7, 30)),
  feature TEXT NOT NULL CHECK (feature IN ('any', 'direct', 'preset', 'global')),
  cohort_size INTEGER NOT NULL CHECK (cohort_size >= 0),
  retained_count INTEGER NOT NULL CHECK (retained_count >= 0 AND retained_count <= cohort_size),
  measured_at INTEGER NOT NULL,
  quality TEXT NOT NULL CHECK (
    quality IN ('on_time_snapshot', 'catchup_current_state', 'pre_rollout_unavailable')
  ),
  PRIMARY KEY (measurement_day, window_days, feature)
);

CREATE INDEX IF NOT EXISTS idx_telegram_adoption_retention_cohort
  ON telegram_adoption_retention_daily(cohort_day, window_days, feature);

CREATE TABLE IF NOT EXISTS telegram_adoption_ingress_quota (
  bucket_start INTEGER PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at INTEGER NOT NULL
);
