-- Event-time pricing audit fields for mint/burn flows
ALTER TABLE mint_burn_events ADD COLUMN price_used REAL;
ALTER TABLE mint_burn_events ADD COLUMN price_timestamp INTEGER;
ALTER TABLE mint_burn_events ADD COLUMN price_source TEXT;
