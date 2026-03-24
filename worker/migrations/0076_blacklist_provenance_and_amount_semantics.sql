-- rollout-safety: backward-compatible

ALTER TABLE blacklist_events ADD COLUMN amount_native REAL;
ALTER TABLE blacklist_events ADD COLUMN amount_usd_at_event REAL;
ALTER TABLE blacklist_events ADD COLUMN amount_source TEXT NOT NULL DEFAULT 'unavailable';
ALTER TABLE blacklist_events ADD COLUMN amount_status TEXT NOT NULL DEFAULT 'recoverable_pending';
ALTER TABLE blacklist_events ADD COLUMN contract_address TEXT;
ALTER TABLE blacklist_events ADD COLUMN config_key TEXT;
ALTER TABLE blacklist_events ADD COLUMN event_signature TEXT;
ALTER TABLE blacklist_events ADD COLUMN event_topic0 TEXT;

UPDATE blacklist_events
SET amount_native = amount
WHERE amount_native IS NULL;

UPDATE blacklist_events
SET amount_usd_at_event = amount_native
WHERE amount_usd_at_event IS NULL
  AND stablecoin IN ('USDC', 'USDT')
  AND amount_native IS NOT NULL;

UPDATE blacklist_events
SET amount_source = CASE
  WHEN amount_native IS NOT NULL THEN 'derived'
  ELSE 'unavailable'
END
WHERE amount_source = 'unavailable';

UPDATE blacklist_events
SET amount_status = CASE
  WHEN amount_native IS NOT NULL THEN 'resolved'
  WHEN chain_id = 'tron' AND event_type IN ('blacklist', 'unblacklist') THEN 'permanently_unavailable'
  ELSE 'recoverable_pending'
END
WHERE amount_status = 'recoverable_pending';

CREATE INDEX IF NOT EXISTS idx_blacklist_events_config_key ON blacklist_events(config_key);
CREATE INDEX IF NOT EXISTS idx_blacklist_events_amount_status ON blacklist_events(amount_status);
