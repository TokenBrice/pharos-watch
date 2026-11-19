-- rollout-safety: backward-compatible
-- Legacy confirmation can replay a retained peak using a different denominator.
-- ABORT makes D1 roll back the event, outcome and pending deletion together.
CREATE TRIGGER trg_depeg_events_pending_closure_rollback_guard
BEFORE INSERT ON depeg_events
WHEN NEW.source = 'live'
  AND NEW.confirmation_sources GLOB 'temporal:*'
  AND NEW.peak_quote_domain IS NULL
  AND EXISTS (
    SELECT 1
    FROM depeg_pending AS pending,
      json_each(CASE WHEN json_valid(pending.peer_basis_json) THEN pending.peer_basis_json END) AS receipt
    WHERE pending.stablecoin_id = NEW.stablecoin_id
      AND pending.peg_type = NEW.peg_type
      AND pending.direction = NEW.direction
      AND pending.first_seen_at = NEW.started_at
      AND pending.first_price = NEW.start_price
      AND CASE WHEN receipt.type = 'object' THEN
        json_extract(receipt.value, '$.basis') = 'benchmark'
        AND json_extract(receipt.value, '$.referenceAdmission.status') = 'admitted'
        AND json_extract(receipt.value, '$.referenceAdmission.kind') IN ('fx', 'fallback')
        AND json_type(receipt.value, '$.referenceAdmission.sessionOpenedAtSec') = 'null'
        AND CASE receipt.key
          WHEN 'onset' THEN
            json_extract(receipt.value, '$.seenAt') = pending.first_seen_at
            AND json_extract(receipt.value, '$.price') = pending.first_price
            AND json_extract(receipt.value, '$.pegReference') = pending.peg_reference
          WHEN 'peak' THEN
            json_extract(receipt.value, '$.price') = pending.peak_price
            AND json_extract(receipt.value, '$.bps') = pending.peak_seen_bps
            AND json_extract(receipt.value, '$.pegReference') = pending.peak_peg_reference
            AND NEW.peak_price = pending.peak_price
            AND NEW.peak_deviation_bps = pending.peak_seen_bps
        END
        AND (
          NEW.peg_reference <> json_extract(receipt.value, '$.pegReference')
          OR ABS((NEW.peak_price / NEW.peg_reference - 1.0) * 10000 - NEW.peak_deviation_bps) > 0.50000001
        )
      END
  )
BEGIN
  SELECT RAISE(ABORT, 'incompatible closure pending promotion');
END;
