-- rollout-safety: backward-compatible
-- Persist exact pending-alert intent provenance and a chat preference generation
-- so queued risk alerts can be revalidated immediately before Telegram send.

ALTER TABLE telegram_subscribers
  ADD COLUMN preference_generation INTEGER NOT NULL DEFAULT 0
  CHECK (preference_generation >= 0);

ALTER TABLE telegram_pending_alerts
  ADD COLUMN source_event_id TEXT
  CHECK (source_event_id IS NULL OR length(source_event_id) <= 200);

ALTER TABLE telegram_pending_alerts
  ADD COLUMN alert_scope_json TEXT
  CHECK (alert_scope_json IS NULL OR length(alert_scope_json) <= 65536);

ALTER TABLE telegram_pending_alerts
  ADD COLUMN preference_generation INTEGER
  CHECK (preference_generation IS NULL OR preference_generation >= 0);

ALTER TABLE telegram_pending_alerts
  ADD COLUMN markup_policy_json TEXT
  CHECK (markup_policy_json IS NULL OR length(markup_policy_json) <= 16384);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN source_event_id TEXT
  CHECK (source_event_id IS NULL OR length(source_event_id) <= 200);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN alert_scope_json TEXT
  CHECK (alert_scope_json IS NULL OR length(alert_scope_json) <= 65536);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN preference_generation INTEGER
  CHECK (preference_generation IS NULL OR preference_generation >= 0);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN markup_policy_json TEXT
  CHECK (markup_policy_json IS NULL OR length(markup_policy_json) <= 16384);

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN cancelled_at INTEGER;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN cancellation_reason TEXT
  CHECK (cancellation_reason IS NULL OR length(cancellation_reason) <= 80);
