-- rollout-safety: backward-compatible
ALTER TABLE depeg_events ADD COLUMN confirmation_sources TEXT;
ALTER TABLE depeg_events ADD COLUMN pending_reason TEXT;
