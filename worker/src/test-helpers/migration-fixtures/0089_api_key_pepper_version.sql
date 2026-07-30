-- rollout-safety: backward-compatible

ALTER TABLE api_keys ADD COLUMN pepper_version INTEGER NOT NULL DEFAULT 1;
