-- rollout-safety: backward-compatible
-- Transfer-level credits live alongside the transaction-keyed legacy ledger.
CREATE TABLE api_key_donor_transfer_credits (
  address TEXT NOT NULL CHECK (length(address) = 42 AND address GLOB '0x[0-9a-f]*'),
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  transfer_discriminator TEXT NOT NULL,
  credited_at INTEGER NOT NULL,
  PRIMARY KEY (address, chain, tx_hash, transfer_discriminator)
);
