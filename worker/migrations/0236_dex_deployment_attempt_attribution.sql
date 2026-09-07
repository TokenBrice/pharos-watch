-- rollout-safety: backward-compatible
--
-- The live Worker continues to read and write the original columns while this
-- migration is applied. The nullable attribution columns are ignored by that
-- Worker. The new reader remains on the conservative coin-level fence until a
-- new-writer batch reconciles legacy last_crawl_at and writes a matching
-- deployment_fence_attribution_at marker.

ALTER TABLE dex_deployment_outcomes
  ADD COLUMN last_attempt_at INTEGER;

ALTER TABLE dex_discovery_meta
  ADD COLUMN deployment_fence_attribution_at INTEGER;

UPDATE dex_deployment_outcomes
   SET last_attempt_at = MAX(
         observed_at,
         COALESCE(
           (SELECT last_crawl_at
              FROM dex_discovery_meta
             WHERE dex_discovery_meta.stablecoin_id = dex_deployment_outcomes.stablecoin_id),
           observed_at
         )
       );
