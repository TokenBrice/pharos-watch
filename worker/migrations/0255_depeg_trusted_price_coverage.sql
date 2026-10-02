-- rollout-safety: backward-compatible
-- NULL means legacy coverage is unknown; never backfill observation boundaries.
-- Old Workers use named columns and ignore these nullable additions.
ALTER TABLE depeg_events ADD COLUMN price_coverage_json TEXT;
ALTER TABLE depeg_events ADD COLUMN last_trusted_price_at INTEGER;
ALTER TABLE depeg_events ADD COLUMN price_coverage_gap_started_at INTEGER;
