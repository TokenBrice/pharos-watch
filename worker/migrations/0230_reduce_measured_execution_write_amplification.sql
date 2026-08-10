-- rollout-safety: backward-compatible
-- These indexes duplicate generation-ledger and target-generation access paths
-- while multiplying every high-volume measured target/quote insert.

DROP INDEX IF EXISTS idx_dex_measured_quotes_generation_coin;
DROP INDEX IF EXISTS idx_dex_measured_targets_pool;
