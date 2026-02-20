-- Remove duplicate dex_liquidity_history rows, keeping the highest-id row per (stablecoin_id, snapshot_date)
DELETE FROM dex_liquidity_history
WHERE id NOT IN (
  SELECT MAX(id) FROM dex_liquidity_history GROUP BY stablecoin_id, snapshot_date
);

-- Prevent future duplicates from concurrent cron runs
CREATE UNIQUE INDEX IF NOT EXISTS idx_dex_hist_unique
  ON dex_liquidity_history(stablecoin_id, snapshot_date);
