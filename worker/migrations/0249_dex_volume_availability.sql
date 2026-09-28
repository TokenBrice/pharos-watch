-- rollout-safety: backward-compatible

-- DEC-19 measured-volume availability (CR-05 release A). Additive nullable JSON
-- record per row: NULL marks a legacy row whose 24h/7d completeness was never
-- recorded (readers publish it as unknown completeness, never as a verified
-- measurement). Previous Workers neither read nor write these columns. No
-- backfill: legacy completeness cannot be reconstructed from stored totals.
ALTER TABLE dex_liquidity ADD COLUMN volume_availability_json TEXT;
ALTER TABLE dex_liquidity_run_rows ADD COLUMN volume_availability_json TEXT;
ALTER TABLE dex_liquidity_history ADD COLUMN volume_availability_json TEXT;
