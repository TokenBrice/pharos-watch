import {
  getApiKeyRateLimitPruneWindowMultiplier,
  getApiKeyRuntimeState,
  getApiKeyUsageUpdateWindowSec,
  getNowSec,
  type ApiKeyDb,
  type AuthenticatedApiKey,
} from "./api-key-core";
import { errorResponse } from "./api-response";

export async function checkApiKeyRateLimit(
  db: ApiKeyDb,
  apiKeyId: number,
  limit: number,
  nowSec = getNowSec(),
): Promise<Response | null> {
  const bucketStart = nowSec - (nowSec % 60);
  const row = await db.prepare(
    `INSERT INTO api_key_rate_limit (api_key_id, bucket_start, count, last_seen_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(api_key_id, bucket_start)
     DO UPDATE SET count = MIN(count + 1, 2147483647), last_seen_at = excluded.last_seen_at
     RETURNING count`,
  )
    .bind(apiKeyId, bucketStart, nowSec)
    .first<{ count: number | null }>();

  const state = getApiKeyRuntimeState();
  if (state.lastApiKeyRateLimitPruneBucket !== bucketStart) {
    state.lastApiKeyRateLimitPruneBucket = bucketStart;
    state.pendingApiKeyPrune = db.prepare("DELETE FROM api_key_rate_limit WHERE bucket_start < ?")
      .bind(bucketStart - (60 * getApiKeyRateLimitPruneWindowMultiplier()))
      .run()
      .then(() => {})
      .catch((error) => {
        console.warn("[api-keys] rate-limit prune failed:", error);
      })
      .finally(() => {
        if (state.pendingApiKeyPrune) {
          state.pendingApiKeyPrune = null;
        }
      });
  }

  if ((row?.count ?? 0) > limit) {
    return errorResponse(429, "Rate limit exceeded", {
      retryAfterSec: bucketStart + 60 - nowSec,
    });
  }

  return null;
}

export function flushPendingApiKeyPrunes(): Promise<void> {
  const state = getApiKeyRuntimeState();
  const pending = state.pendingApiKeyPrune;
  if (!pending) return Promise.resolve();
  state.pendingApiKeyPrune = null;
  return pending;
}

export async function recordApiKeyUsage(
  db: ApiKeyDb,
  key: AuthenticatedApiKey,
  routePath: string,
  nowSec = getNowSec(),
): Promise<void> {
  const state = getApiKeyRuntimeState();
  const lastUpdatedAt = state.apiKeyLastUsageUpdateById.get(key.id) ?? 0;
  if (nowSec - lastUpdatedAt < getApiKeyUsageUpdateWindowSec()) {
    return;
  }

  await db.prepare(
    "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
  )
    .bind(nowSec, routePath, key.id)
    .run();
  state.apiKeyLastUsageUpdateById.set(key.id, nowSec);
}
