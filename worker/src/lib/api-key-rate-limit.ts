import { logWorkerEventArgs } from "./structured-log";
import { API_KEY_MIN_RATE_LIMIT_PER_MINUTE, API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC } from "@shared/lib/ops-limits";
import {
  API_KEY_RATE_LIMIT_PRUNE_WINDOW_MULTIPLIER,
  API_KEY_MONTHLY_USAGE_READ_FAILURE_TTL_SEC,
  admitIsolateLocalApiKeyQuota,
  claimApiKeyRateLimitPruneBucket,
  shouldRecordApiKeyUsage,
  markApiKeyUsageRecorded,
  getNowSec,
  isApiKeyOverQuota,
  isApiKeyRateLimitDependencyCircuitOpen,
  memoizeApiKeyOverQuota,
  getCachedApiKeyMonthlyUsage,
  memoizeApiKeyMonthlyUsage,
  isApiKeyMonthlyUsageReadBlocked,
  memoizeApiKeyMonthlyUsageReadFailure,
  resolveApiKeyMonthlyRequestQuota,
  utcMonthStartSec,
  type ApiKeyDb,
  type AuthenticatedApiKey,
} from "./api-key-core";
import { D1_INT32_MAX } from "./d1-constants";
import { errorResponse, jsonResponse } from "./api-response";

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
  return errorResponse(429, "Rate limit exceeded", { retryAfterSec, noStore: true });
}

function apiKeyMonthlyQuotaExceededResponse(nowSec: number): Response {
  const date = new Date(nowSec * 1000);
  const retryAfterSec = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000 - nowSec;
  return jsonResponse(
    { error: "Monthly request quota exceeded", reason: "monthly_quota_exceeded" },
    { status: 429, retryAfterSec, noStore: true },
  );
}

let lastMonthlyQuotaWarnMinute = -1;

/** Monthly quota enforcement fails open: unavailable usage evidence never blocks a key. */
function warnMonthlyQuotaUnavailableOncePerMinute(nowSec: number, message: string, error?: unknown): void {
  const minute = Math.floor(nowSec / 60);
  if (minute === lastMonthlyQuotaWarnMinute) return;
  lastMonthlyQuotaWarnMinute = minute;
  logWorkerEventArgs("lib", "warn", "[api-keys] monthly quota check unavailable: " + message, error);
}

type MonthlyQuotaSubject = Pick<AuthenticatedApiKey, "id" | "tier" | "plan" | "trafficClass" | "rateLimitPerMinute" | "monthlyRequestQuota">;

function monthlyQuotaVerdict(key: MonthlyQuotaSubject, usage: number, nowSec: number): Response | null {
  const quota = resolveApiKeyMonthlyRequestQuota(key);
  return quota != null && usage >= quota
    ? apiKeyMonthlyQuotaExceededResponse(nowSec)
    : null;
}

/** One shared in-flight usage read per key per isolate, so bursts cost one query. */
const monthlyUsageReadsInFlight = new Map<number, Promise<number>>();

function readApiKeyMonthlyUsage(db: ApiKeyDb, apiKeyId: number, monthStartSec: number): Promise<number> {
  const inFlight = monthlyUsageReadsInFlight.get(apiKeyId);
  if (inFlight) return inFlight;
  const read = db
    .prepare("SELECT request_count FROM api_key_monthly_usage WHERE api_key_id = ? AND month_start = ?")
    .bind(apiKeyId, monthStartSec)
    .first<{ request_count: number }>()
    .then((row) => row?.request_count ?? 0)
    .finally(() => {
      monthlyUsageReadsInFlight.delete(apiKeyId);
    });
  monthlyUsageReadsInFlight.set(apiKeyId, read);
  return read;
}

/**
 * Slow-path monthly request volume quota. Month-to-date usage is a single
 * api_key_monthly_usage row through a per-isolate memo (refreshed at most
 * every API_KEY_MONTHLY_USAGE_MEMO_TTL_SEC); before
 * API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC no usage read happens at all. Fails open
 * when usage cannot be measured: a failed read is memoized for 60 seconds, and
 * the read is skipped while the rate-limit dependency circuit is open.
 */
export async function checkApiKeyMonthlyRequestQuota(
  db: ApiKeyDb,
  key: MonthlyQuotaSubject,
  nowSec = getNowSec(),
  attributionDisabled = false,
): Promise<Response | null> {
  if (nowSec < API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC) return null;
  if (resolveApiKeyMonthlyRequestQuota(key) == null) return null;
  const monthStartSec = utcMonthStartSec(nowSec);
  const memoizedUsage = getCachedApiKeyMonthlyUsage(key.id, monthStartSec, nowSec);
  if (memoizedUsage != null) {
    return monthlyQuotaVerdict(key, memoizedUsage, nowSec);
  }
  if (isApiKeyMonthlyUsageReadBlocked(key.id, nowSec)) return null;
  if (attributionDisabled) {
    warnMonthlyQuotaUnavailableOncePerMinute(nowSec, "API_KEY_REQUEST_ATTRIBUTION_DISABLED is set; usage cannot be measured");
    return null;
  }
  if (isApiKeyRateLimitDependencyCircuitOpen()) return null;
  try {
    const usage = await readApiKeyMonthlyUsage(db, key.id, monthStartSec);
    memoizeApiKeyMonthlyUsage(key.id, monthStartSec, usage, nowSec);
    return monthlyQuotaVerdict(key, usage, nowSec);
  } catch (error) {
    memoizeApiKeyMonthlyUsageReadFailure(key.id, nowSec + API_KEY_MONTHLY_USAGE_READ_FAILURE_TTL_SEC);
    warnMonthlyQuotaUnavailableOncePerMinute(nowSec, "usage read failed", error);
    return null;
  }
}

/** Fast-path monthly quota check: consults the memo only, never D1. No fresh memo admits. */
export function checkCachedApiKeyMonthlyRequestQuota(
  key: MonthlyQuotaSubject,
  nowSec = getNowSec(),
): Response | null {
  if (nowSec < API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC) return null;
  const monthStartSec = utcMonthStartSec(nowSec);
  const usage = getCachedApiKeyMonthlyUsage(key.id, monthStartSec, nowSec);
  return usage == null ? null : monthlyQuotaVerdict(key, usage, nowSec);
}

/**
 * Standard keys keep their own per-minute budget in the isolate-local fallback;
 * donor and self-serve keys never degrade to it (the access gate fails them
 * closed during a limiter-storage outage).
 */
export function resolveIsolateFallbackApiKeyRateLimit(limit: number): number {
  return Math.max(API_KEY_MIN_RATE_LIMIT_PER_MINUTE, limit);
}

export async function checkApiKeyRateLimit(
  db: ApiKeyDb,
  apiKeyId: number,
  limit: number,
  nowSec = getNowSec(),
  execCtx?: ExecutionContext,
): Promise<Response | null> {
  const { bucketStart, retryAfterSec } = apiKeyRateLimitBucket(nowSec);
  if (isApiKeyOverQuota(apiKeyId, limit, bucketStart)) {
    return apiKeyRateLimitExceededResponse(retryAfterSec);
  }
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

  const count = row?.count ?? 0;
  if (count > limit) {
    memoizeApiKeyOverQuota(apiKeyId, bucketStart, count);
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
