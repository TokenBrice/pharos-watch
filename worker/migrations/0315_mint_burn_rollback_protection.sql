-- rollout-safety: backward-compatible
-- data-migration: reviewed
ALTER TABLE mint_burn_events ADD COLUMN usdz_receipt_review TEXT
  CHECK (usdz_receipt_review IN ('known-bridge-pool-without-bridge-signal', 'tx-context-unavailable'));

UPDATE mint_burn_events SET usdz_receipt_review = burn_review_reason
WHERE stablecoin_id = 'usdz-anzen' AND burn_type = 'review_required'
  AND burn_review_reason IN ('known-bridge-pool-without-bridge-signal', 'tx-context-unavailable');

CREATE TRIGGER trg_mint_burn_usdz_receipt_review
AFTER UPDATE OF burn_type, burn_review_reason ON mint_burn_events
WHEN NEW.usdz_receipt_review IS NOT NULL
  AND (NEW.burn_type IS NOT 'review_required' OR NEW.burn_review_reason IS NOT NEW.usdz_receipt_review)
BEGIN
  UPDATE mint_burn_events SET burn_type = 'review_required', burn_review_reason = NEW.usdz_receipt_review
    WHERE id = NEW.id;
END;

-- Ethereum MUSD is a bridge spoke. Materialize that role even for legacy writers.
UPDATE mint_burn_events SET flow_type = 'bridge_transfer'
WHERE stablecoin_id = 'meusd-mezo' AND chain_id = 'ethereum' AND flow_type IS NOT 'bridge_transfer';

CREATE TRIGGER trg_mint_burn_mezo_spoke_insert
AFTER INSERT ON mint_burn_events
WHEN NEW.stablecoin_id = 'meusd-mezo' AND NEW.chain_id = 'ethereum' AND NEW.flow_type IS NOT 'bridge_transfer'
BEGIN
  UPDATE mint_burn_events SET flow_type = 'bridge_transfer' WHERE id = NEW.id;
END;

CREATE TRIGGER trg_mint_burn_mezo_spoke_update
AFTER UPDATE OF flow_type ON mint_burn_events
WHEN NEW.stablecoin_id = 'meusd-mezo' AND NEW.chain_id = 'ethereum' AND NEW.flow_type IS NOT 'bridge_transfer'
BEGIN
  UPDATE mint_burn_events SET flow_type = 'bridge_transfer' WHERE id = NEW.id;
END;

-- Every row in an existing spoke bucket is excluded from issuer flow.
UPDATE mint_burn_hourly
SET mint_count = 0, burn_count = 0, mint_volume_usd = 0, burn_volume_usd = 0, net_flow_usd = 0,
  mint_unpriced_event_count = 0, burn_unpriced_event_count = 0, mint_unresolved_event_count = 0, burn_unresolved_event_count = 0
WHERE stablecoin_id = 'meusd-mezo' AND chain_id = 'ethereum';

-- Fence legacy publishers that read the old buckets before this migration.
-- The trailing key and migration marker are separate from operator disables.
INSERT INTO mint_burn_publication_policy (id, disabled_keys, updated_at)
SELECT 1, '["ethereum-0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186","migration:0315"]', unixepoch()
WHERE EXISTS (SELECT 1 FROM mint_burn_publication_policy WHERE id = 1)
   OR EXISTS (SELECT 1 FROM mint_burn_hourly WHERE stablecoin_id = 'meusd-mezo' AND chain_id = 'ethereum')
   OR EXISTS (SELECT 1 FROM mint_burn_events WHERE stablecoin_id = 'meusd-mezo' AND chain_id = 'ethereum')
   OR EXISTS (SELECT 1 FROM mint_burn_scan_coverage WHERE config_key = 'ethereum-0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186')
   OR EXISTS (SELECT 1 FROM mint_burn_sync_state WHERE config_key = 'ethereum-0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186')
ON CONFLICT(id) DO UPDATE SET disabled_keys = json_insert(
  CASE WHEN json_type(CASE WHEN json_valid(disabled_keys) THEN disabled_keys ELSE 'null' END) = 'array'
    THEN disabled_keys ELSE '[]' END,
  '$[#]', json_extract(excluded.disabled_keys, '$[0]'), '$[#]', 'migration:0315'
), updated_at = excluded.updated_at;

CREATE TRIGGER trg_mint_burn_mezo_spoke_policy
AFTER UPDATE OF disabled_keys ON mint_burn_publication_policy
WHEN CASE WHEN json_valid(OLD.disabled_keys) THEN json_extract(OLD.disabled_keys, '$[#-1]') END = 'migration:0315'
  AND json_extract(NEW.disabled_keys, '$[#-1]') IS NOT 'migration:0315'
BEGIN
  UPDATE mint_burn_publication_policy
  SET disabled_keys = json_insert(NEW.disabled_keys, '$[#]', json_extract(OLD.disabled_keys, '$[#-2]'),
    '$[#]', 'migration:0315')
  WHERE id = NEW.id;
END;

DELETE FROM cache
WHERE (key >= 'mint-burn-flows:v8:aggregate:' AND key < 'mint-burn-flows:v8:aggregate;')
   OR (key >= 'mint-burn-flows:v8:coin:meusd-mezo:' AND key < 'mint-burn-flows:v8:coin:meusd-mezo;');

UPDATE tape_events SET suppressed_at = unixepoch(), suppression_reason = 'flow-claim-retracted'
WHERE coin_id = 'meusd-mezo' AND chain = 'ethereum' AND source_table = 'mint_burn_events'
  AND type IN ('mint_burn.large_mint', 'mint_burn.large_burn') AND suppressed_at IS NULL;
