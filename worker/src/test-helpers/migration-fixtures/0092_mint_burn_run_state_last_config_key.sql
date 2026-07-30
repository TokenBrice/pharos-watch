-- rollout-safety: backward-compatible

ALTER TABLE mint_burn_run_state ADD COLUMN last_config_key TEXT;
