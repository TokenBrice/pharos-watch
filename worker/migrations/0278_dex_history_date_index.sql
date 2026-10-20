-- rollout-safety: backward-compatible
-- Support global history windows and retention without changing coin/date uniqueness.
CREATE INDEX IF NOT EXISTS idx_dex_hist_snapshot_date
  ON dex_liquidity_history(snapshot_date);
