import { logWorkerEventArgs } from "./structured-log";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { BLACKLIST_DERIVED_GENERATION_KEY, BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY, getBlacklistDerivedCacheKeys } from "./blacklist-cache-keys";

export interface BlacklistSummaryFence {
  generation: string | null;
  summaryValue: string | null;
}

export async function captureBlacklistSummaryFence(db: D1Database): Promise<BlacklistSummaryFence> {
  const row = await runWithOverloadRetry(() => db.prepare(`/* blacklist-summary-fence-capture */ SELECT
    (SELECT value FROM cache WHERE key = ?) AS generation,
    (SELECT value FROM cache WHERE key = ?) AS summaryValue`)
    .bind(BLACKLIST_DERIVED_GENERATION_KEY, BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY)
    .first<BlacklistSummaryFence>(), 3, undefined, { waitOutResourceWindow: true });
  if (row == null) throw new Error("blacklist-summary-fence-missing");
  return row;
}

export interface BlacklistCacheInvalidationResult {
  attempted: number;
  deleted: number;
  failed: number;
}

export async function invalidateBlacklistDerivedCaches(
  db: D1Database,
  ownRepairFence?: BlacklistSummaryFence,
): Promise<BlacklistCacheInvalidationResult> {
  const keys = getBlacklistDerivedCacheKeys();
  const rotation = crypto.randomUUID();
  try {
    const results = await runWithOverloadRetry(() => db.batch<{ value: string }>([
      db.prepare(`DELETE FROM cache WHERE key IN (${keys.map(() => "?").join(", ")})`).bind(...keys),
      // A retry must retain self-ownership proof without restoring a previously visible token (ABA).
      db.prepare(`/* blacklist-derived-generation-rotate */
        INSERT INTO cache (key, value, updated_at) VALUES (?,
          json_object('token', ?, 'rotation', ?, 'ownsFence', ?), unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = json_set(excluded.value, '$.ownsFence',
          CASE WHEN ? AND (cache.value IS ? OR
            CASE WHEN json_valid(cache.value) THEN
              json_extract(cache.value, '$.rotation') = ? AND json_extract(cache.value, '$.ownsFence') = 1
            ELSE 0 END) THEN 1 ELSE 0 END), updated_at = excluded.updated_at
        ${ownRepairFence ? "RETURNING value" : ""}`)
        .bind(BLACKLIST_DERIVED_GENERATION_KEY, crypto.randomUUID(), rotation,
          ownRepairFence?.generation === null ? 1 : 0, ownRepairFence ? 1 : 0,
          ownRepairFence?.generation ?? null, rotation),
    ]), 3, undefined, { waitOutResourceWindow: true });
    if (ownRepairFence) {
      const value = results[1].results[0]?.value;
      if (value && (JSON.parse(value) as { ownsFence: number }).ownsFence === 1) ownRepairFence.generation = value;
    }
    return { attempted: keys.length, deleted: keys.length, failed: 0 };
  } catch (error) {
    logWorkerEventArgs("lib", "warn", `[blacklist-cache] Failed to invalidate ${keys.length}/${keys.length} derived cache row(s)`, error);
    return { attempted: keys.length, deleted: 0, failed: keys.length };
  }
}
