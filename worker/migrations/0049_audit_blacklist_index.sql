-- Composite index for filtered+sorted blacklist pagination (SCHEMA-005)
CREATE INDEX IF NOT EXISTS idx_blacklist_events_chain_ts
ON blacklist_events (chain_name, timestamp DESC);
