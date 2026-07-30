-- rollout-safety: backward-compatible
-- Retain bounded same-notional route observations and producer coverage with
-- prospective daily DEX snapshots. Legacy rows remain valid and readable.

ALTER TABLE dex_liquidity_history ADD COLUMN exit_route_summary_json TEXT;
