-- rollout-safety: backward-compatible
-- Ensure daily DEX-liquidity history repairs replace one coin/day row instead
-- of appending duplicates. Keep the newest duplicate row before adding the
-- unique key because repair retries write the improved snapshot later.

DELETE FROM dex_liquidity_history
WHERE id NOT IN (
  SELECT MAX(id)
  FROM dex_liquidity_history
  GROUP BY stablecoin_id, snapshot_date
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dex_hist_coin_date_unique
  ON dex_liquidity_history(stablecoin_id, snapshot_date DESC);
