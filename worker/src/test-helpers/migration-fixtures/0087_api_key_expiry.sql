-- rollout-safety: backward-compatible

ALTER TABLE api_keys
ADD COLUMN expires_at INTEGER;
