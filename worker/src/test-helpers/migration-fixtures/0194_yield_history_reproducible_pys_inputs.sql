-- rollout-safety: backward-compatible

ALTER TABLE yield_history ADD COLUMN pys_inputs_at_publish TEXT;
