-- rollout-safety: backward-compatible
-- One supporter API key per donating wallet: the claim row and the api_keys row
-- are written in a single batch, so the address primary key is the concurrency fence.
CREATE TABLE api_key_donor_claims (
  address TEXT PRIMARY KEY CHECK (length(address) = 42 AND address GLOB '0x[0-9a-f]*'),
  key_prefix TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL
);
