import { getCache } from "./db";
import { CACHE_FRESHNESS_THRESHOLDS } from "./constants";

// --- Shared types ---

export interface CacheStatus {
  ageSeconds: number | null;
  maxAge: number;
  healthy: boolean;
}

// --- Shared cache freshness logic ---

/**
 * Queries the cache table and evaluates freshness for every key in
 * CACHE_FRESHNESS_THRESHOLDS. Used by both /health and /status endpoints.
 */
export async function buildCacheStatuses(
  db: D1Database,
  now: number,
): Promise<{ caches: Record<string, CacheStatus>; worstRatio: number }> {
  const cacheKeys = Object.keys(CACHE_FRESHNESS_THRESHOLDS);
  const cacheRows = await db
    .prepare(`SELECT key, value, updated_at FROM cache WHERE key IN (${cacheKeys.map(() => '?').join(',')})`)
    .bind(...cacheKeys)
    .all<{ key: string; value: string; updated_at: number }>();
  const cacheMap = new Map((cacheRows.results ?? []).map(r => [r.key, { value: r.value, updatedAt: r.updated_at }]));

  const caches: Record<string, CacheStatus> = {};
  let worstRatio = 0;

  for (const [key, maxAge] of Object.entries(CACHE_FRESHNESS_THRESHOLDS)) {
    const cached = cacheMap.get(key);
    const ageSeconds = cached ? now - cached.updatedAt : null;
    const ratio = ageSeconds != null ? ageSeconds / maxAge : Infinity;
    if (ratio > worstRatio) worstRatio = ratio;
    caches[key] = { ageSeconds, maxAge, healthy: ratio <= 1.5 };
  }

  return { caches, worstRatio };
}

/**
 * Wraps an API handler with standardized error handling.
 * Catches unhandled exceptions, logs them with the endpoint name, and returns a 500 JSON response.
 *
 * CORS headers are applied in index.ts after the handler returns,
 * so error responses from this wrapper get CORS automatically.
 */
type ApiHandler<T extends unknown[] = unknown[]> = (...args: T) => Promise<Response>;

export function withErrorHandler<T extends unknown[]>(
  endpoint: string,
  handler: ApiHandler<T>,
): ApiHandler<T> {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`[api] Error in ${endpoint}:`, err);
      return new Response(
        JSON.stringify({ error: "Internal Server Error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  };
}

/** Validates a stablecoin ID: numeric DefiLlama IDs or prefixed commodity/CG IDs */
export function isValidStablecoinId(id: string): boolean {
  return /^\d+$/.test(id) || /^(?:gold|silver|cg)-/.test(id);
}

/**
 * Creates a cache-passthrough API handler that reads from the cache table
 * and returns the cached JSON with freshness headers.
 */
export function createCacheHandler(
  endpoint: string,
  cacheKey: string,
  cacheControl: string,
  maxAgeSec: number,
): (db: D1Database) => Promise<Response> {
  return withErrorHandler(endpoint, async (db: D1Database): Promise<Response> => {
    const cached = await getCache(db, cacheKey);
    if (!cached) {
      return new Response(JSON.stringify({ error: "Data not yet available" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(cached.value, {
      headers: addFreshnessHeaders({
        "Content-Type": "application/json",
        "Cache-Control": cacheControl,
      }, cached.updatedAt, maxAgeSec),
    });
  });
}

/**
 * Adds data freshness headers to a cache-passthrough response.
 * - X-Data-Age: seconds since cache was last updated
 * - Warning: RFC 7234 stale-data warning when data exceeds maxAgeSec
 * Purely additive — never changes response body or status.
 */
export function addFreshnessHeaders(
  headers: Record<string, string>,
  updatedAt: number,
  maxAgeSec: number,
): Record<string, string> {
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  const result: Record<string, string> = { ...headers, "X-Data-Age": String(age) };
  if (age > maxAgeSec) {
    result["Warning"] = `110 - "Response is stale (${age}s old, max ${maxAgeSec}s)"`;
  }
  return result;
}
