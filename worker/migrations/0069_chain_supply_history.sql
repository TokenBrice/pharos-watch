-- Chain supply history: daily snapshots of per-chain stablecoin supply totals.
-- ~50 chains x 1 row/day = ~50 rows/day. Negligible storage.
CREATE TABLE IF NOT EXISTS chain_supply_history (
  chain_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,
  total_usd REAL NOT NULL,
  stablecoin_count INTEGER NOT NULL,
  PRIMARY KEY (chain_id, snapshot_date)
);
