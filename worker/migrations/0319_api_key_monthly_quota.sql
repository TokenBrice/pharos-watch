-- rollout-safety: backward-compatible

-- Explicit per-key monthly request quota. NULL keeps the tier default resolved
-- at request time (donor, commercial, or free-partner by rate limit); a
-- positive integer overrides it for one key. No backfill: existing keys keep
-- the tier default. Old Workers ignore the nullable column and their
-- named-column inserts remain valid.
ALTER TABLE api_keys ADD COLUMN monthly_request_quota INTEGER;

-- Month-to-date request rollup per key, maintained by the buffered api-key
-- attribution flush that writes api_key_request_stats (throttled 429s stay
-- excluded). One row per (api_key_id, month_start) keeps the quota check a
-- single-row read instead of a month-long SUM over 60-second buckets. Plain
-- rowid table: the shared bounded retention drain selects by rowid.
CREATE TABLE IF NOT EXISTS api_key_monthly_usage (
  api_key_id INTEGER NOT NULL,
  month_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, month_start)
);
