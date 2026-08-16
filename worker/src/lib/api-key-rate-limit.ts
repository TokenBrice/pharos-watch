import { logWorkerEventArgs } from "./structured-log";
import {
  API_KEY_DEPENDENCY_RETRY_AFTER_SEC,
  API_KEY_MIN_RATE_LIMIT_PER_MINUTE,
  CIRCUIT_OPEN_THRESHOLD,
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import {
  API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES,
  API_KEY_RATE_LIMIT_PRUNE_WINDOW_MULTIPLIER,
  API_KEY_USAGE_UPDATE_CACHE_MAX_ENTRIES,
  API_KEY_USAGE_UPDATE_WINDOW_SEC,
  capApiKeyMapEntries,
  getApiKeyRuntimeState,
  getNowSec,
  type ApiKeyDb,
  type AuthenticatedApiKey,
} from "./api-key-core";
import { D1_INT32_MAX } from "./d1-constants";
import { errorResponse } from "./api-response";

const API_KEY_RATE_LIMIT_CIRCUIT_COOLDOWN_MS = API_KEY_DEPENDENCY_RETRY_AFTER_SEC * 1000;

export interface ApiKeyRateLimitDependencyCircuitSnapshot {
  consecutiveFailures: number;
  openUntilMs: number;
  opened: boolean;
}

export function isApiKeyRateLimitDependencyCircuitOpen(nowMs = Date.now()): boolean {
  return getApiKeyRuntimeState().apiKeyRateLimitDependencyCircuit.openUntilMs > nowMs;
}

export function recordApiKeyRateLimitDependencySuccess(): void {
  const circuit = getApiKeyRuntimeState().apiKeyRateLimitDependencyCircuit;
  circuit.consecutiveFailures = 0;
  circuit.openUntilMs = 0;
}

export function recordApiKeyRateLimitDependencyFailure(
  nowMs = Date.now(),
): ApiKeyRateLimitDependencyCircuitSnapshot {
  const circuit = getApiKeyRuntimeState().apiKeyRateLimitDependencyCircuit;
  if (circuit.openUntilMs > nowMs) {
    return {
      consecutiveFailures: circuit.consecutiveFailures,
      openUntilMs: circuit.openUntilMs,
      opened: true,
    };
  }

  circuit.consecutiveFailures += 1;
  if (circuit.consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD) {
    circuit.openUntilMs = nowMs + API_KEY_RATE_LIMIT_CIRCUIT_COOLDOWN_MS;
  }

  return {
    consecutiveFailures: circuit.consecutiveFailures,
    openUntilMs: circuit.openUntilMs,
    opened: circuit.openUntilMs > nowMs,
  };
}

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

  const state = getApiKeyRuntimeState();
  if (state.lastApiKeyRateLimitPruneBucket !== bucketStart) {
    state.lastApiKeyRateLimitPruneBucket = bucketStart;
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
  const state = getApiKeyRuntimeState();
  if (state.lastApiKeyFallbackRateLimitPruneBucket !== bucketStart) {
    state.lastApiKeyFallbackRateLimitPruneBucket = bucketStart;
    for (const [keyId, entry] of state.apiKeyFallbackRateLimitById) {
      if (entry.bucketStart !== bucketStart) {
        state.apiKeyFallbackRateLimitById.delete(keyId);
      }
    }
  }
  const existing = state.apiKeyFallbackRateLimitById.get(apiKeyId);

  if (!existing || existing.bucketStart !== bucketStart) {
    state.apiKeyFallbackRateLimitById.delete(apiKeyId);
    state.apiKeyFallbackRateLimitById.set(apiKeyId, {
      bucketStart,
      count: 1,
    });
    capApiKeyMapEntries(state.apiKeyFallbackRateLimitById, API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES);
    return null;
  }

  existing.count = Math.min(existing.count + 1, D1_INT32_MAX);
  state.apiKeyFallbackRateLimitById.delete(apiKeyId);
  state.apiKeyFallbackRateLimitById.set(apiKeyId, existing);
  if (existing.count > limit) {
    return apiKeyRateLimitExceededResponse(retryAfterSec);
  }

  return null;
}

export async function recordApiKeyUsage(
  db: ApiKeyDb,
  key: AuthenticatedApiKey,
  routePath: string,
  nowSec = getNowSec(),
): Promise<void> {
  const state = getApiKeyRuntimeState();
  const lastUpdatedAt = state.apiKeyLastUsageUpdateById.get(key.id) ?? 0;
  if (nowSec - lastUpdatedAt < API_KEY_USAGE_UPDATE_WINDOW_SEC) {
    return;
  }

  await db.prepare(
    "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
  )
    .bind(nowSec, routePath, key.id)
    .run();
  state.apiKeyLastUsageUpdateById.delete(key.id);
  state.apiKeyLastUsageUpdateById.set(key.id, nowSec);
  capApiKeyMapEntries(state.apiKeyLastUsageUpdateById, API_KEY_USAGE_UPDATE_CACHE_MAX_ENTRIES);
}
