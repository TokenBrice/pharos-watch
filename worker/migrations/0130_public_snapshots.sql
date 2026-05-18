-- rollout-safety: backward-compatible
-- public_snapshots: daily gzipped JSON envelopes of canonical caches projected
-- by the snapshot-public-dataset cron. Serves "what did Pharos say on date X"
-- via the as-of API. Idempotent on snapshot_date and write-once: same-day
-- re-runs leave the existing row untouched.
CREATE TABLE IF NOT EXISTS public_snapshots (
  snapshot_date TEXT PRIMARY KEY,        -- ISO 8601 UTC, e.g. "2026-05-16"
  payload_gz BLOB NOT NULL,              -- gzipped JSON payload (CompressionStream)
  methodology_versions TEXT NOT NULL,    -- JSON map of methodology version strings (small)
  content_hash TEXT NOT NULL,            -- sha256 hex of the uncompressed JSON
  byte_size INTEGER NOT NULL,            -- size of the uncompressed JSON in bytes
  created_at INTEGER NOT NULL            -- epoch seconds when the row was written
);
