import { YieldCoinCohortSchema, type YieldCoinCohort } from "@shared/types/yield";

const COHORT_CACHE_KEY = "yield-rankings:coin-cohort:v1";

type YieldCoinCache = { value: string; updatedAt: number };

/** Read the published envelope and one complete row without transferring the cohort. */
export function readYieldRankingsCoinCache(db: D1Database, stablecoinId: string): Promise<YieldCoinCache | null> {
  return db.prepare(`SELECT CASE WHEN json_valid(c.value) THEN CASE WHEN json_type(c.value) = 'object' AND json_type(c.value, '$.rankings') = 'array' THEN json_set(c.value, '$.rankings', json((
      SELECT json_group_array(json(r.value)) FROM json_each(c.value, '$.rankings') AS r
      WHERE json_extract(r.value, '$.id') = ?
    ))) ELSE c.value END ELSE c.value END AS value, c.updated_at AS updatedAt
    FROM cache AS c WHERE c.key = 'yield-rankings'`)
    .bind(stablecoinId).first<YieldCoinCache>();
}

/** SQL selects only the requested comparator result, never the whole census. */
export async function readYieldCoinCohort(db: D1Database, stablecoinId: string, signature: string, now: number): Promise<YieldCoinCohort | null> {
  const scopedValueSql = `json_set(value, '$.rankings', json((
    SELECT json_group_array(json(r.value)) FROM json_each(c.value, '$.rankings') r
    WHERE json_extract(r.value, '$.id') = ?
  )))`;
  const row = await db.prepare(`SELECT ${scopedValueSql} AS value FROM cache c WHERE key = ? AND json_valid(value)
      AND json_extract(value, '$.signature') = ?
      AND json_extract(value, '$.assessedAt') <= ?
      AND json_extract(value, '$.validUntil') > ?`)
    .bind(stablecoinId, COHORT_CACHE_KEY, signature, now, now).first<{ value: string }>();
  if (!row) return null;
  const parsed = YieldCoinCohortSchema.safeParse(JSON.parse(row.value));
  if (parsed.success) return parsed.data;
  // Remove only the invalid derivative actually inspected. A concurrent valid
  // replacement or active build lease must survive this repair admission.
  await db.prepare(`DELETE FROM cache AS c WHERE key = ? AND json_valid(value)
    AND ${scopedValueSql} = ?`).bind(COHORT_CACHE_KEY, stablecoinId, row.value).run();
  return null;
}

/** A durable pre-build lease coalesces different cold coin URLs across isolates. */
export async function claimYieldCoinCohort(
  db: D1Database,
  signature: string,
  owner: string,
  now: number,
): Promise<{ leaseUntil: number } | null> {
  const leaseUntil = now + 30;
  const value = JSON.stringify({ signature, owner, leaseUntil });
  const claimed = await db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE NOT json_valid(cache.value) OR (
      COALESCE(json_extract(cache.value, '$.leaseUntil'), 0) <= ?
      AND (json_extract(cache.value, '$.signature') != ?
        OR COALESCE(json_extract(cache.value, '$.validUntil'), 0) <= ?))
    RETURNING key`).bind(COHORT_CACHE_KEY, value, now, now, signature, now).first<{ key: string }>();
  return claimed !== null ? { leaseUntil } : null;
}

/**
 * Read only the active pre-build lease (never the published cohort) for
 * diagnostics. A published cohort has no `owner`, so it is not transferred.
 */
export async function readYieldCoinCohortLease(
  db: D1Database,
): Promise<{ signature: string; owner: string; leaseUntil: number } | null> {
  const row = await db.prepare(`SELECT value FROM cache WHERE key = ? AND json_valid(value)
    AND json_type(value, '$.owner') = 'text' AND json_type(value, '$.leaseUntil') = 'integer'`)
    .bind(COHORT_CACHE_KEY).first<{ value: string }>();
  if (!row) return null;
  const lease = JSON.parse(row.value) as { signature?: unknown; owner?: unknown; leaseUntil?: unknown };
  return typeof lease.signature === "string" && typeof lease.owner === "string" && typeof lease.leaseUntil === "number"
    ? { signature: lease.signature, owner: lease.owner, leaseUntil: lease.leaseUntil }
    : null;
}

export async function publishYieldCoinCohort(db: D1Database, owner: string, cohort: YieldCoinCohort): Promise<void> {
  const admitted = YieldCoinCohortSchema.parse(cohort);
  await db.prepare(`UPDATE cache SET value = ?, updated_at = ? WHERE key = ?
    AND json_valid(value) AND json_extract(value, '$.owner') = ?`)
    .bind(JSON.stringify(admitted), admitted.assessedAt, COHORT_CACHE_KEY, owner).run();
}

export async function releaseYieldCoinCohort(db: D1Database, owner: string): Promise<void> {
  await db.prepare(`DELETE FROM cache WHERE key = ? AND json_valid(value)
    AND json_extract(value, '$.owner') = ?`).bind(COHORT_CACHE_KEY, owner).run();
}
