-- rollout-safety: backward-compatible
-- data-migration: reviewed
-- Only the basis-aware planner reads this table. Formatted chunks use the existing delivery queue.
CREATE TABLE telegram_reference_alert_plans (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind = 'alert'),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planning', 'ready', 'cancelled')),
  cursor TEXT,
  planned_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT
);
CREATE INDEX idx_telegram_reference_alert_plans_order ON telegram_reference_alert_plans(created_at, job_id);
CREATE TRIGGER trg_telegram_reference_alert_plan_closed AFTER UPDATE OF state ON telegram_reference_alert_plans
WHEN NEW.state IN ('ready', 'cancelled') BEGIN
  INSERT INTO telegram_jobs (job_id, kind, payload_json, state, cursor, planned_count, created_at, expires_at, completed_at, error)
  VALUES (NEW.job_id, NEW.kind, NEW.payload_json, NEW.state, NEW.cursor, NEW.planned_count, NEW.created_at, NEW.expires_at, NEW.completed_at, NEW.error);
  DELETE FROM telegram_reference_alert_plans WHERE job_id = NEW.job_id;
END;
