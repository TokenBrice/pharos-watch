-- rollout-safety: backward-compatible
-- Family-generic diagnostic store. Retain the Orca-only table for Worker rollback;
-- its four diagnostic rows are intentionally not copied. Cleanup is a separate rollout.
CREATE TABLE IF NOT EXISTS dex_native_shadow_quotes_v2 (
  pool_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot > 0),
  quoted_at INTEGER NOT NULL,
  notional_usd REAL NOT NULL CHECK (notional_usd > 0),
  token_mint_in TEXT NOT NULL,
  token_mint_out TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  input_price_usd REAL NOT NULL CHECK (input_price_usd > 0),
  input_decimals INTEGER NOT NULL CHECK (input_decimals BETWEEN 0 AND 18),
  model_version TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK (profile_id IN ('orca-whirlpool-exact-v1', 'raydium-clmm-exact-v1')),
  capability_id TEXT NOT NULL CHECK (capability_id = 'measured-adapter-shadow'),
  score_eligible INTEGER NOT NULL DEFAULT 0 CHECK (score_eligible = 0),
  PRIMARY KEY (pool_id, stablecoin_id, slot, notional_usd, model_version)
);
CREATE INDEX IF NOT EXISTS idx_dex_native_shadow_quotes_v2_retention
  ON dex_native_shadow_quotes_v2(quoted_at);
