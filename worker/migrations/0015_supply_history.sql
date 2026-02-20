CREATE TABLE IF NOT EXISTS supply_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,  -- UTC midnight epoch seconds
  circulating_usd REAL NOT NULL,   -- total mcap in USD
  price REAL,                      -- USD price at snapshot time
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX idx_supply_hist_date
  ON supply_history(snapshot_date DESC);
