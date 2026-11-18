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

DELETE FROM cache
WHERE (key >= 'mint-burn-flows:v8:aggregate:' AND key < 'mint-burn-flows:v8:aggregate;')
   OR (key >= 'mint-burn-flows:v8:coin:meusd-mezo:' AND key < 'mint-burn-flows:v8:coin:meusd-mezo;');

UPDATE tape_events SET suppressed_at = unixepoch(), suppression_reason = 'flow-claim-retracted'
WHERE coin_id = 'meusd-mezo' AND chain = 'ethereum' AND source_table = 'mint_burn_events'
  AND type IN ('mint_burn.large_mint', 'mint_burn.large_burn') AND suppressed_at IS NULL;
