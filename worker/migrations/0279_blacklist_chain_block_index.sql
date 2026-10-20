-- rollout-safety: backward-compatible
-- Bound exact-block order repair reads; retain semantic identity and public pagination.
CREATE INDEX IF NOT EXISTS idx_blacklist_events_chain_block
  ON blacklist_events(chain_id, block_number);
