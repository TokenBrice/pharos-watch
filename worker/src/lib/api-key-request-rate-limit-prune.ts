import type { MinimalD1Database } from "./minimal-d1";

/**
 * The two self-serve bucket tables run byte-identical counter logic against
 * different column names. The table names are a closed set because SQLite
 * cannot bind identifiers; `worker/src/api/api-key-requests/rate-limit.ts`
 * validates every limiter target against it, and the daily housekeeping pass
 * prunes exactly these tables.
 */
export type ApiKeyRequestBucketedLimitTable =
  | "api_key_request_rate_limit_v2"
  | "api_key_self_serve_issuance_limits";

export const API_KEY_REQUEST_BUCKETED_LIMIT_TABLE_NAMES = new Set<ApiKeyRequestBucketedLimitTable>([
  "api_key_request_rate_limit_v2",
  "api_key_self_serve_issuance_limits",
]);

export async function pruneOldApiKeyRequestRateLimits(
  db: MinimalD1Database,
  olderThanSec: number,
  limit = 5_000,
): Promise<{ deleted: number; truncated: boolean }> {
  let deleted = 0;
  let truncated = false;
  for (const table of API_KEY_REQUEST_BUCKETED_LIMIT_TABLE_NAMES) {
    // SAFETY: table iterates the closed API_KEY_REQUEST_BUCKETED_LIMIT_TABLE_NAMES allowlist above; no caller input reaches the SQL.
    const result = await db.prepare(
      `DELETE FROM ${table}
       WHERE rowid IN (
         SELECT rowid FROM ${table}
         WHERE bucket_start < ?
         ORDER BY bucket_start ASC
         LIMIT ?
       )`,
    )
      .bind(olderThanSec, limit)
      .run();
    const tableDeleted = result.meta?.changes ?? 0;
    deleted += tableDeleted;
    truncated ||= tableDeleted >= limit;
  }
  return { deleted, truncated };
}
