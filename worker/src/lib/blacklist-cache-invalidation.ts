import { logWorkerEventArgs } from "./structured-log";
import { deleteCache } from "./db-cache";
import { getBlacklistDerivedCacheKeys } from "./blacklist-cache-keys";

export interface BlacklistCacheInvalidationResult {
  attempted: number;
  deleted: number;
  failed: number;
}

export async function invalidateBlacklistDerivedCaches(db: D1Database): Promise<BlacklistCacheInvalidationResult> {
  const keys = getBlacklistDerivedCacheKeys();
  const results = await Promise.allSettled(keys.map((key) => deleteCache(db, key)));
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed > 0) {
    logWorkerEventArgs("lib", "warn", `[blacklist-cache] Failed to invalidate ${failed}/${keys.length} derived cache row(s)`);
  }
  return {
    attempted: keys.length,
    deleted: keys.length - failed,
    failed,
  };
}
