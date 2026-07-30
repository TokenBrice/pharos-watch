-- rollout-safety: backward-compatible
-- Durable last-good vault rates for authoritative parent-derived pricing routes
-- (ERC-4626 convertToAssets, Aave previewRedeem, Idle CDO virtualPrice). When a
-- live rate read fails, the pricing sync can publish cached-rate × fresh trusted
-- parent price under the explicit low-confidence `protocol-redeem-cached-rate`
-- source instead of a missing active price. Worker reads/writes tolerate a
-- missing table, so deploy order is not coupled to this migration.

CREATE TABLE IF NOT EXISTS authoritative_vault_rates (
  stablecoin_id TEXT PRIMARY KEY,
  rate REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
