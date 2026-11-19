-- rollout-safety: backward-compatible
ALTER TABLE supply_history ADD COLUMN circulating_native REAL;
ALTER TABLE supply_history ADD COLUMN valuation_price_usd REAL;
ALTER TABLE supply_history ADD COLUMN valuation_observed_at_sec INTEGER;
