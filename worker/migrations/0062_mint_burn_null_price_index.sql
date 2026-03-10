-- Speeds up recurring NULL-price backlog scans used by mint/burn auto-heal.
CREATE INDEX IF NOT EXISTS idx_mbe_null_price_ts
ON mint_burn_events(timestamp DESC)
WHERE amount_usd IS NULL;
