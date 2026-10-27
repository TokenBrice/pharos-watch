-- rollout-safety: backward-compatible

-- Partial-chain provenance of the daily supply_history observation (K-031,
-- Pricing Pipeline v6.59). The daily snapshot writes the validated
-- supplySource, supplyObservedAt and supplyChainGuard of the admitted current
-- row as JSON, so a numeric remainder that excludes quarantined chains
-- (partialCoverage) stays distinguishable from a complete total in history.
--
-- NULL means coverage is unrecorded (unknown, never complete): every row
-- written before this migration, rows written by a prior Worker, and admin
-- backfill rows. No backfill: historical chain coverage cannot be
-- reconstructed.
ALTER TABLE supply_history ADD COLUMN supply_provenance TEXT;
