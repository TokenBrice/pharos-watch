-- 0061: Add liquidity coverage-confidence metadata for current rows and history snapshots.

ALTER TABLE dex_liquidity ADD COLUMN coverage_class TEXT NOT NULL DEFAULT 'unobserved';
ALTER TABLE dex_liquidity ADD COLUMN coverage_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE dex_liquidity ADD COLUMN source_mix_json TEXT;
ALTER TABLE dex_liquidity ADD COLUMN balance_measured_tvl_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE dex_liquidity ADD COLUMN organic_measured_tvl_usd REAL NOT NULL DEFAULT 0;

ALTER TABLE dex_liquidity_history ADD COLUMN coverage_class TEXT NOT NULL DEFAULT 'unobserved';
ALTER TABLE dex_liquidity_history ADD COLUMN coverage_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE dex_liquidity_history ADD COLUMN source_mix_json TEXT;

-- Existing non-empty rows predate explicit source-family persistence. Mark them legacy so
-- downstream consumers do not mistake them for current-confidence observations.
UPDATE dex_liquidity
SET
  coverage_class = CASE
    WHEN stablecoin_id = '__global__' THEN 'unobserved'
    WHEN liquidity_score IS NOT NULL AND total_tvl_usd > 0 THEN 'legacy'
    ELSE 'unobserved'
  END,
  coverage_confidence = CASE
    WHEN stablecoin_id = '__global__' THEN 0
    WHEN liquidity_score IS NOT NULL AND total_tvl_usd > 0 THEN 0.5
    ELSE 0
  END
WHERE coverage_class = 'unobserved' AND coverage_confidence = 0;

UPDATE dex_liquidity_history
SET
  coverage_class = CASE
    WHEN liquidity_score IS NOT NULL AND total_tvl_usd > 0 THEN 'legacy'
    ELSE 'unobserved'
  END,
  coverage_confidence = CASE
    WHEN liquidity_score IS NOT NULL AND total_tvl_usd > 0 THEN 0.5
    ELSE 0
  END
WHERE coverage_class = 'unobserved' AND coverage_confidence = 0;
