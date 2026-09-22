-- rollout-safety: backward-compatible
-- Project the machine-readable reason of every non-ok cron run out of
-- `metadata` into its own nullable column so status aggregates and operator
-- paging need no per-job JSON paths. Older Workers ignore the column; removing
-- it requires a separate coordinated cleanup rollout.
ALTER TABLE cron_runs ADD COLUMN degraded_reason TEXT;
