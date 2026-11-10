-- rollout-safety: backward-compatible
-- Exact token units are prospective evidence; legacy REAL amounts remain unknown.
ALTER TABLE mint_burn_events ADD COLUMN amount_raw TEXT
  CHECK (amount_raw IS NULL OR (length(amount_raw) > 0 AND amount_raw NOT GLOB '*[^0-9]*'));
-- Old rows were above the cutoff by construction; the cutoff becomes display-only.
ALTER TABLE mint_burn_events ADD COLUMN below_display_threshold INTEGER NOT NULL DEFAULT 0
  CHECK (below_display_threshold IN (0, 1));

-- Full transaction populations include excluded legs, across every flow type.
CREATE INDEX IF NOT EXISTS idx_mbe_transaction_group
  ON mint_burn_events(tx_hash, stablecoin_id, chain_id);
