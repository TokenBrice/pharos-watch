-- rollout-safety: backward-compatible

-- Persist the TVL-bounded challenger projection used when a coin has no
-- accepted current v2 challenger head. NULL marks rows written before this
-- column existed; the reader then falls back to the display-oriented
-- top_pools_json slice. Previous Workers neither read nor write this column.
ALTER TABLE dex_liquidity ADD COLUMN challenger_pools_json TEXT;
ALTER TABLE dex_liquidity_run_rows ADD COLUMN challenger_pools_json TEXT;
