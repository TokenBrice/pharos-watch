-- rollout-safety: backward-compatible
-- Ledger donations already converted into supporter-key access. Each counted
-- donation is credited once; it is written in the same batch that sets the
-- key's expiry, so re-signing never credits a donation twice.
CREATE TABLE api_key_donor_credits (
  address TEXT NOT NULL CHECK (length(address) = 42 AND address GLOB '0x[0-9a-f]*'),
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  credited_at INTEGER NOT NULL,
  PRIMARY KEY (address, chain, tx_hash)
);
