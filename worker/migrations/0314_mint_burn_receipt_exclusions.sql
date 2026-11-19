-- rollout-safety: backward-compatible
-- data-migration: reviewed
ALTER TABLE mint_burn_events ADD COLUMN receipt_flow_exclusion TEXT
  CHECK (receipt_flow_exclusion IN ('bridge_transfer', 'protocol_internal',
    'ousd-trustee-fee-context-unavailable', 'ousd-trustee-fee-unproven'));

-- Only receipt-aware writers can revise this exclusion. Legacy hourly rebuilds
-- and counted-event readers see the same effective class as the source receipt.
CREATE TRIGGER trg_mint_burn_receipt_flow_exclusion
AFTER UPDATE OF flow_type ON mint_burn_events
WHEN NEW.receipt_flow_exclusion IN ('bridge_transfer', 'protocol_internal')
  AND NEW.flow_type IS NOT NEW.receipt_flow_exclusion
BEGIN
  UPDATE mint_burn_events SET flow_type = NEW.receipt_flow_exclusion WHERE id = NEW.id;
END;

CREATE TRIGGER trg_mint_burn_receipt_review
AFTER UPDATE OF burn_type, burn_review_reason ON mint_burn_events
WHEN NEW.receipt_flow_exclusion IN ('ousd-trustee-fee-context-unavailable', 'ousd-trustee-fee-unproven')
  AND (NEW.burn_type IS NOT 'review_required' OR NEW.burn_review_reason IS NOT NEW.receipt_flow_exclusion)
BEGIN
  UPDATE mint_burn_events SET burn_type = 'review_required', burn_review_reason = NEW.receipt_flow_exclusion
    WHERE id = NEW.id;
END;
