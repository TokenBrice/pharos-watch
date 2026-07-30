-- rollout-safety: backward-compatible
-- Preserve whether observed-time freshness came from upstream metadata or local fetch time.
ALTER TABLE price_cache ADD COLUMN observed_at_mode TEXT;
