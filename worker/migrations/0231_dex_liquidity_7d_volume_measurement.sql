-- rollout-safety: backward-compatible

ALTER TABLE dex_liquidity ADD COLUMN total_volume_7d_measured INTEGER;
ALTER TABLE dex_liquidity_run_rows ADD COLUMN total_volume_7d_measured INTEGER;
