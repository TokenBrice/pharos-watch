-- rollout-safety: backward-compatible
-- Apply before Worker activation; old writers leave NULL, which new admission rejects.
ALTER TABLE reserve_composition ADD COLUMN config_fingerprint TEXT;
ALTER TABLE reserve_sync_state ADD COLUMN config_fingerprint TEXT;
