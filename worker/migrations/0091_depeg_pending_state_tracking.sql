-- rollout-safety: backward-compatible

ALTER TABLE depeg_pending ADD COLUMN last_seen_bps INTEGER;
ALTER TABLE depeg_pending ADD COLUMN last_seen_at INTEGER;
ALTER TABLE depeg_pending ADD COLUMN last_price REAL;
ALTER TABLE depeg_pending ADD COLUMN peak_seen_bps INTEGER;
ALTER TABLE depeg_pending ADD COLUMN peak_price REAL;
ALTER TABLE depeg_pending ADD COLUMN updated_at INTEGER;
