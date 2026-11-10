-- rollout-safety: backward-compatible
-- Prospective operator evidence only; previous Workers ignore this empty table.
CREATE TABLE mint_burn_supply_reconciliation (
  config_key TEXT NOT NULL,
  day_ts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'unexplained-residual', 'review-suppression', 'unavailable', 'unsupported-law')),
  checked_at INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  PRIMARY KEY (config_key, day_ts)
);
CREATE INDEX idx_mbsr_day ON mint_burn_supply_reconciliation(day_ts);
