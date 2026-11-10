-- rollout-safety: backward-compatible
-- Immutable range evidence has a separate acceptance/invalidation lifecycle.
CREATE TABLE IF NOT EXISTS mint_burn_supply_proof_configs (
  config_key TEXT PRIMARY KEY,
  config_fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mint_burn_supply_proofs (
  proof_id TEXT PRIMARY KEY,
  config_key TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  from_block INTEGER NOT NULL CHECK (from_block >= 1),
  to_block INTEGER NOT NULL CHECK (to_block >= from_block),
  status TEXT NOT NULL CHECK (status IN ('proven', 'residual', 'unavailable')),
  reason TEXT,
  evidence_json TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'pending' CHECK (lifecycle IN ('pending', 'accepted', 'invalidated')),
  invalidated_at INTEGER,
  invalidation_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_mbsp_config_range
  ON mint_burn_supply_proofs (config_key, from_block, to_block);
CREATE INDEX IF NOT EXISTS idx_mbsp_config_lifecycle
  ON mint_burn_supply_proofs (config_key, lifecycle);

ALTER TABLE mint_burn_events ADD COLUMN supply_proof_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mbe_supply_proof
  ON mint_burn_events (supply_proof_id) WHERE supply_proof_id IS NOT NULL;
