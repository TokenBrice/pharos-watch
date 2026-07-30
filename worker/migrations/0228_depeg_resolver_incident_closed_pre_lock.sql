-- rollout-safety: backward-compatible

ALTER TABLE depeg_resolver_incidents ADD COLUMN closed_pre_lock_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_ddr_incident_closed_pre_lock_at
  ON depeg_resolver_incidents(closed_pre_lock_at)
  WHERE closed_pre_lock_at IS NOT NULL;
