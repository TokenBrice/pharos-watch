-- Per-job cron lease table for single-writer execution fencing.
-- Used by acquireCronLease/renewCronLease/releaseCronLease primitives in worker/src/lib/db.ts.

CREATE TABLE IF NOT EXISTS cron_leases (
  job TEXT PRIMARY KEY,
  lease_owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_leases_until ON cron_leases(lease_until);
