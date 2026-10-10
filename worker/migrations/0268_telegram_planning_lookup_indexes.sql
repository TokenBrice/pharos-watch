-- rollout-safety: backward-compatible
-- Count every persisted chunk for one plan without rescanning the source cohort.
CREATE INDEX IF NOT EXISTS idx_tajt_source_generation_plan
  ON telegram_alert_job_targets(source_event_id, plan_generation, plan_key);

-- Bounded follower pages seek in chat/preset order instead of sorting the cohort.
CREATE INDEX IF NOT EXISTS idx_telegram_preset_followers_cursor
  ON telegram_preset_subscriptions(
    chat_id, preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
  );