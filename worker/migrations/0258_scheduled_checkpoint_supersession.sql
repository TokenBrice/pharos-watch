-- rollout-safety: backward-compatible
ALTER TABLE worker_scheduled_checkpoints ADD COLUMN superseded_by_json TEXT;
