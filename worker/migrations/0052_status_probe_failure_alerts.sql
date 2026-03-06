-- Reconciliation no-op: the probe-failure columns are now part of
-- 0047_status_reliability.sql for fresh databases, and production already
-- has these columns outside the migration ledger.
SELECT 1;
