-- rollout-safety: backward-compatible
-- Preserve price-cache provenance and timestamp semantics for safe replay.
ALTER TABLE price_cache ADD COLUMN source TEXT;
ALTER TABLE price_cache ADD COLUMN confidence TEXT;
ALTER TABLE price_cache ADD COLUMN observed_at INTEGER;
ALTER TABLE price_cache ADD COLUMN synced_at INTEGER;
ALTER TABLE price_cache ADD COLUMN agree_sources_json TEXT;
ALTER TABLE price_cache ADD COLUMN consensus_sources_json TEXT;
