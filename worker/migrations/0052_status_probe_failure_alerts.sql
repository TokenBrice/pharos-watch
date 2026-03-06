ALTER TABLE status_discrepancy_state
  ADD COLUMN consecutive_probe_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE status_discrepancy_state
  ADD COLUMN last_probe_failure_at INTEGER;

ALTER TABLE status_discrepancy_state
  ADD COLUMN last_probe_alert_at INTEGER;
