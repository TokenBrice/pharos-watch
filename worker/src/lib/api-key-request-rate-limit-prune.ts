import { runBoundedPrune } from "./bounded-prune";
import type { MinimalD1Database } from "./minimal-d1";

/**
 * Retain housekeeping for the retired self-serve request tables until their
 * separate destructive D1 cleanup rollout. Table names remain a closed set
 * because SQLite cannot bind identifiers.
 */
type ApiKeyRequestBucketedLimitTable =
  | "api_key_request_rate_limit_v2"
  | "api_key_self_serve_issuance_limits";

const API_KEY_REQUEST_BUCKETED_LIMIT_TABLE_NAMES = new Set<ApiKeyRequestBucketedLimitTable>([
  "api_key_request_rate_limit_v2",
  "api_key_self_serve_issuance_limits",
]);

export async function pruneOldApiKeyRequestRateLimits(
  db: MinimalD1Database,
  olderThanSec: number,
  limit = 5_000,
  runLimit = 100_000,
  signal?: AbortSignal,
): Promise<{ deleted: number; truncated: boolean }> {
  let deleted = 0;
  let truncated = false;
  for (const table of API_KEY_REQUEST_BUCKETED_LIMIT_TABLE_NAMES) {
    const result = await runBoundedPrune({
      batchLimit: limit,
      runLimit: runLimit - deleted,
      signal,
      // SAFETY: table iterates the closed allowlist above; no caller input reaches the SQL.
      deleteBatch: (batchLimit) => db.prepare(
        `DELETE FROM ${table}
         WHERE rowid IN (
           SELECT rowid FROM ${table}
           WHERE bucket_start < ?
           ORDER BY bucket_start ASC
           LIMIT ?
         )`,
      ).bind(olderThanSec, batchLimit).run(),
    });
    deleted += result.deleted;
    if (deleted >= runLimit) {
      truncated = true;
      break;
    }
  }
  return { deleted, truncated };
}
