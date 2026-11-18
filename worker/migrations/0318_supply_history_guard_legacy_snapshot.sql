-- rollout-safety: backward-compatible
-- data-migration: reviewed
-- The legacy writer drops quantity evidence but preserves the stock source
-- and observation clock. Match that observation before withholding an unsafe conversion.
CREATE TRIGGER trg_supply_history_guard_legacy_snapshot
AFTER INSERT ON supply_history
WHEN NEW.circulating_native IS NULL
  AND CASE WHEN json_valid(NEW.supply_provenance)
    THEN json_type(NEW.supply_provenance, '$.nativeQuantityUnavailable') IS NULL
    ELSE 0 END
BEGIN
  UPDATE supply_history
  SET price = NULL, price_observed_at = NULL,
      supply_provenance = CASE WHEN NEW.price IS NULL THEN
        json_set(NEW.supply_provenance, '$.nativeQuantityUnavailable', json('true'))
      ELSE json_set(NEW.supply_provenance, '$.nativeQuantityUnavailable', json('true'),
        '$.marketQuote', json_object('price', NEW.price, 'observedAt', NEW.price_observed_at)) END
  WHERE stablecoin_id = NEW.stablecoin_id AND snapshot_date = NEW.snapshot_date
    AND EXISTS (
      SELECT 1 FROM cache, json_each(CASE WHEN json_valid(cache.value) THEN cache.value END, '$.peggedAssets') AS asset
      WHERE cache.key = 'stablecoins'
        AND cache.updated_at BETWEEN NEW.snapshot_date - 1800 AND NEW.snapshot_date + 86399
        AND asset.type = 'object'
        AND json_extract(asset.value, '$.id') = NEW.stablecoin_id
        AND json_extract(asset.value, '$.supplySource') IS json_extract(NEW.supply_provenance, '$.supplySource')
        AND json_extract(asset.value, '$.supplyObservedAt') IS json_extract(NEW.supply_provenance, '$.supplyObservedAt')
        AND (json_type(asset.value, '$.circulatingNative') = 'null'
          OR (json_type(asset.value, '$.circulatingNative') IN ('real', 'integer')
            AND (NEW.price IS NULL OR NEW.circulating_usd / NEW.price <> json_extract(asset.value, '$.circulatingNative'))))
    );
END;

CREATE TRIGGER trg_supply_history_guard_measured_conversion
BEFORE UPDATE OF price ON supply_history
WHEN OLD.price IS NULL AND NEW.price IS NOT NULL AND OLD.circulating_native IS NOT NULL
  AND (OLD.circulating_usd / NEW.price IS NOT OLD.circulating_native
    OR CASE WHEN json_valid(OLD.supply_provenance)
      THEN json_extract(OLD.supply_provenance, '$.marketQuote.price') IS NOT NULL END)
BEGIN
  SELECT RAISE(IGNORE);
END;
