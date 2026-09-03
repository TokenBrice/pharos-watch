-- rollout-safety: backward-compatible
-- Preserve the reserve composition payload digest without duplicating payload JSON.
ALTER TABLE reserve_composition_history ADD COLUMN payload_sha256 TEXT;
