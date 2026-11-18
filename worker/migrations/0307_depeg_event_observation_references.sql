-- rollout-safety: backward-compatible
ALTER TABLE depeg_events ADD COLUMN peak_peg_reference REAL;
ALTER TABLE depeg_events ADD COLUMN peak_quote_domain TEXT;
ALTER TABLE depeg_events ADD COLUMN recovery_peg_reference REAL;
ALTER TABLE depeg_events ADD COLUMN admitted_coverage_json TEXT;
ALTER TABLE depeg_events ADD COLUMN disposition TEXT;
ALTER TABLE depeg_events ADD COLUMN recovery_evidence_source TEXT;
ALTER TABLE depeg_events ADD COLUMN peer_basis_json TEXT;
ALTER TABLE depeg_pending ADD COLUMN peak_peg_reference REAL;
ALTER TABLE depeg_pending ADD COLUMN peer_basis_json TEXT;
ALTER TABLE depeg_pending ADD COLUMN reference_market_held_at INTEGER;
-- The legacy price_coverage_json object has a strict schema. Keep its hold witness separate.
ALTER TABLE depeg_events ADD COLUMN reference_hold_json TEXT;
ALTER TABLE depeg_events ADD COLUMN recovery_usd_observed_at INTEGER;
ALTER TABLE depeg_events ADD COLUMN recovery_usd_first_seen_at INTEGER;
