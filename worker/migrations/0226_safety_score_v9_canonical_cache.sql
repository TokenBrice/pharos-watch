-- rollout-safety: backward-compatible
-- Seed the canonical V9 cache keys from the last accepted shadow-era
-- publication. The Worker accepts the legacy compressed envelope for this
-- release and overwrites it with the canonical publication format on the next
-- successful V9 run. Shadow-era rows remain available for rollback and are
-- deleted only by the separately coordinated cleanup migration.

INSERT INTO cache (key, value, updated_at)
SELECT 'report-cards:v9', value, updated_at
FROM cache
WHERE key = 'report-cards:v9-shadow'
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at
WHERE cache.updated_at <= excluded.updated_at;

INSERT INTO cache (key, value, updated_at)
SELECT 'report-cards:v9:publication-health', value, updated_at
FROM cache
WHERE key = 'report-cards:v9-shadow:publication-health'
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at
WHERE cache.updated_at <= excluded.updated_at;
