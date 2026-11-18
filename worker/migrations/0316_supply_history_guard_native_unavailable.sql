-- rollout-safety: backward-compatible
-- Legacy same-day repair must leave an independently observed market quote
-- out of the column that legacy detail divides into the USD cap.
CREATE TRIGGER trg_supply_history_guard_native_unavailable
BEFORE UPDATE OF price ON supply_history
WHEN OLD.price IS NULL AND NEW.price IS NOT NULL
  AND CASE WHEN json_valid(OLD.supply_provenance)
    THEN json_type(OLD.supply_provenance, '$.nativeQuantityUnavailable') = 'true'
    ELSE 0 END
BEGIN
  SELECT RAISE(IGNORE);
END;
