-- rollout-safety: backward-compatible
-- 0182: Bootstrap the current validated DEWS cache pointer into the durable
-- generic publication ledger before tape projectors require ledger proof.

INSERT OR IGNORE INTO surface_publication_generations (
  surface,
  generation_id,
  started_at,
  validated_at,
  published_at,
  state,
  candidate_rows,
  published_rows,
  expected_rows,
  validation_summary_json,
  artifact_checksum,
  artifact_cache_key
)
SELECT
  'dews',
  'dews:' || CAST(updated_at AS TEXT),
  updated_at,
  updated_at,
  updated_at,
  'published',
  CASE WHEN json_valid(value) AND json_type(value, '$.expectedRowCount') = 'integer'
    THEN json_extract(value, '$.expectedRowCount') END,
  CASE WHEN json_valid(value) AND json_type(value, '$.expectedRowCount') = 'integer'
    THEN json_extract(value, '$.expectedRowCount') END,
  CASE WHEN json_valid(value) AND json_type(value, '$.expectedRowCount') = 'integer'
    THEN json_extract(value, '$.expectedRowCount') END,
  value,
  CASE WHEN json_valid(value) THEN json_extract(value, '$.stablecoinIdsDigest') END,
  'dews:published-generation'
FROM cache
WHERE key = 'dews:published-generation'
  AND CASE WHEN json_valid(value) THEN json_extract(value, '$.source') END = 'compute-dews'
  AND CASE WHEN json_valid(value) THEN json_extract(value, '$.publishStatus') END = 'published'
  AND CASE WHEN json_valid(value) THEN json_extract(value, '$.updatedAt') END = updated_at
  AND (
    CASE WHEN json_valid(value) THEN json_extract(value, '$.coverageVersion') END IS NULL
    OR (
      CASE WHEN json_valid(value) THEN json_extract(value, '$.coverageVersion') END = 2
      AND CASE WHEN json_valid(value) THEN json_type(value, '$.expectedRowCount') END = 'integer'
      AND CASE WHEN json_valid(value) THEN json_extract(value, '$.expectedRowCount') END > 0
      AND length(CASE WHEN json_valid(value) THEN json_extract(value, '$.stablecoinIdsDigest') END) = 64
      AND CASE WHEN json_valid(value) THEN json_extract(value, '$.stablecoinIdsDigest') END
        NOT GLOB '*[^0-9a-f]*'
    )
  );
