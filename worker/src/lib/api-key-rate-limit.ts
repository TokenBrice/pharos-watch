import { logWorkerEventArgs } from "./structured-log";
import {
  API_KEY_MIN_RATE_LIMIT_PER_MINUTE,
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import {
  API_KEY_RATE_LIMIT_PRUNE_WINDOW_MULTIPLIER,
  admitIsolateLocalApiKeyQuota,
  claimApiKeyRateLimitPruneBucket,
  shouldRecordApiKeyUsage,
  markApiKeyUsageRecorded,
  getNowSec,
  type ApiKeyDb,
  type AuthenticatedApiKey,
} from "./api-key-core";
import { D1_INT32_MAX } from "./d1-constants";
import { errorResponse } from "./api-response";

/** Per-key limiter bucket width. Shared by the D1 and isolate-local limiters. */
const API_KEY_RATE_LIMIT_BUCKET_SEC = 60;

interface ApiKeyRateLimitBucket {
  bucketStart: number;
  retryAfterSec: number;
}

/**
 * Fixed 60s window shared by both per-key limiters. Keeping one derivation is
 * what guarantees the D1 path and the isolate-local fallback bucket a request
 * into the same minute and report the same Retry-After.
 */
function apiKeyRateLimitBucket(nowSec: number): ApiKeyRateLimitBucket {
  const bucketStart = nowSec - (nowSec % API_KEY_RATE_LIMIT_BUCKET_SEC);
  return { bucketStart, retryAfterSec: bucketStart + API_KEY_RATE_LIMIT_BUCKET_SEC - nowSec };
}

function apiKeyRateLimitExceededResponse(retryAfterSec: number): Response {
  return errorResponse(429, "Rate limit exceeded", { retryAfterSec });
}

export function resolveIsolateFallbackApiKeyRateLimit(limit: number): number {
  return Math.max(
    API_KEY_MIN_RATE_LIMIT_PER_MINUTE,
    Math.min(limit, SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE),
  );
}

export async function checkApiKeyRateLimit(
  db: ApiKeyDb,
  apiKeyId: number,
  limit: number,
  nowSec = getNowSec(),
  execCtx?: ExecutionContext,
): Promise<Response | null> {
  const { bucketStart, retryAfterSec } = apiKeyRateLimitBucket(nowSec);
  const row = await db.prepare(
    `INSERT INTO api_key_rate_limit (api_key_id, bucket_start, count, last_seen_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(api_key_id, bucket_start)
     DO UPDATE SET count = MIN(count + 1, ${D1_INT32_MAX}), last_seen_at = excluded.last_seen_at
     RETURNING count`,
  )
    .bind(apiKeyId, bucketStart, nowSec)
    .first<{ count: number | null }>();

  if (claimApiKeyRateLimitPruneBucket(bucketStart)) {
    // Handed straight to the request lifetime instead of parked in module state
    // for a later flush: `waitUntil` already keeps the isolate alive for it.
    execCtx?.waitUntil(
      db.prepare("DELETE FROM api_key_rate_limit WHERE bucket_start < ?")
        .bind(bucketStart - (API_KEY_RATE_LIMIT_BUCKET_SEC * API_KEY_RATE_LIMIT_PRUNE_WINDOW_MULTIPLIER))
        .run()
        .then(() => {})
        .catch((error) => {
          logWorkerEventArgs("lib", "warn", "[api-keys] rate-limit prune failed:", error);
        }),
    );
  }

  if ((row?.count ?? 0) > limit) {
    return apiKeyRateLimitExceededResponse(retryAfterSec);
  }

  return null;
}

export function checkIsolateLocalApiKeyRateLimit(
  apiKeyId: number,
  limit: number,
  nowSec = getNowSec(),
): Response | null {
  const { bucketStart, retryAfterSec } = apiKeyRateLimitBucket(nowSec);
  return admitIsolateLocalApiKeyQuota(apiKeyId, limit, bucketStart)
    ? null : apiKeyRateLimitExceededResponse(retryAfterSec);
}

export async function recordApiKeyUsage(
  db: ApiKeyDb,
  key: AuthenticatedApiKey,
  routePath: string,
  nowSec = getNowSec(),
): Promise<void> {
  if (!shouldRecordApiKeyUsage(key.id, nowSec)) {
    return;
  }

  await db.prepare(
    "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
  )
    .bind(nowSec, routePath, key.id)
    .run();
  markApiKeyUsageRecorded(key.id, nowSec);
}
