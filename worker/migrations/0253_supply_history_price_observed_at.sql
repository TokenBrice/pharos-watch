-- rollout-safety: backward-compatible

-- Actual observation clock of supply_history.price (DEC-08, mint-burn-flow
-- v6.23). The daily snapshot writes the published asset's priceObservedAt
-- beside the price, and writes a price only when it is an actual observation
-- (never a nominal par reference). Mint/burn event-time valuation admits a
-- snapshot price only when this clock is within +/-24h of the event, so the
-- snapshot's UTC day label is no longer treated as an observation time.
--
-- NULL means the observation time is unknown: every row written before this
-- migration, rows written by a prior Worker, and admin backfill rows. Those
-- prices remain for other readers but are never mint/burn event evidence. No
-- backfill: historical observation clocks cannot be reconstructed.
ALTER TABLE supply_history ADD COLUMN price_observed_at INTEGER;
