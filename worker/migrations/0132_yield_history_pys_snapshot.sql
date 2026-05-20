-- rollout-safety: backward-compatible

ALTER TABLE yield_history ADD COLUMN pys_at_publish REAL;
ALTER TABLE yield_history ADD COLUMN safety_at_publish REAL;
ALTER TABLE yield_history ADD COLUMN variance_at_publish REAL;
