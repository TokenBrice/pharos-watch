-- rollout-safety: backward-compatible
ALTER TABLE dex_price_challenger_payloads_v2 ADD COLUMN price_lineage_json TEXT;
