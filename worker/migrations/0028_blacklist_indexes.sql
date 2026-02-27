CREATE INDEX IF NOT EXISTS idx_be_chain_name ON blacklist_events(chain_name);
CREATE INDEX IF NOT EXISTS idx_be_event_type ON blacklist_events(event_type);
