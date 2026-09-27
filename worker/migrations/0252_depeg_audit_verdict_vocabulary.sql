-- rollout-safety: backward-compatible
-- Existing Workers emit only this vocabulary. Preserve all stored rows; reject new
-- unknown verdicts rather than allowing them to bypass DDR's invalidation guards.
-- Authority: shared/types/depeg-audit.ts; latest-schema behavior matrix pins parity.
CREATE TRIGGER IF NOT EXISTS trg_depeg_provenance_audit_verdict_insert_guard
BEFORE INSERT ON depeg_event_provenance
WHEN NEW.audit_verdict IS NOT NULL
  AND NEW.audit_verdict NOT IN ('confirmed', 'disputed', 'false_positive', 'no_data', 'repaired')
BEGIN
  SELECT RAISE(ABORT, 'unknown depeg audit verdict');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_provenance_audit_verdict_update_guard
BEFORE UPDATE OF audit_verdict ON depeg_event_provenance
WHEN NEW.audit_verdict IS NOT NULL
  AND NEW.audit_verdict NOT IN ('confirmed', 'disputed', 'false_positive', 'no_data', 'repaired')
BEGIN
  SELECT RAISE(ABORT, 'unknown depeg audit verdict');
END;
