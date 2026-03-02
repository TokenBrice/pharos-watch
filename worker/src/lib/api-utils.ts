import { getCache } from "./db";
import { CACHE_FRESHNESS_THRESHOLDS } from "./constants";
import type { CacheStatus } from "../../../src/lib/types";

export type { CacheStatus };

// --- Data freshness metadata ---

export interface FreshnessMeta {
  updatedAt: number;
  ageSeconds: number;
  status: "fresh" | "degraded" | "stale";
}

export function buildFreshnessMeta(updatedAt: number, maxAgeSec: number): FreshnessMeta {
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  const ratio = age / maxAgeSec;
  return {
    updatedAt,
    ageSeconds: age,
    status: ratio <= 1 ? "fresh" : ratio <= 1.5 ? "degraded" : "stale",
  };
}

// --- Shared cache freshness logic ---

/**
 * Keys in CACHE_FRESHNESS_THRESHOLDS that live in dedicated tables rather than
 * the `cache` key/value table, and need table-specific freshness queries.
 */
const TABLE_FRESHNESS_QUERIES: Record<string, string> = {
  "dex-liquidity": "SELECT MIN(? - updated_at) as age FROM dex_liquidity WHERE liquidity_score > 0",
  "yield-data":    "SELECT MIN(? - updated_at) as age FROM yield_data",
  "dews":          "SELECT MIN(? - computed_at) as age FROM stress_signals",
};

/**
 * Queries the cache table and evaluates freshness for every key in
 * CACHE_FRESHNESS_THRESHOLDS. Used by both /health and /status endpoints.
 *
 * For keys stored in dedicated tables (dex-liquidity, yield-data, dews), the
 * table is queried directly instead of the cache key/value store.
 */
export async function buildCacheStatuses(
  db: D1Database,
  now: number,
): Promise<{ caches: Record<string, CacheStatus>; worstRatio: number }> {
  // Fetch rows from the generic cache table (excludes table-backed keys)
  const cacheOnlyKeys = Object.keys(CACHE_FRESHNESS_THRESHOLDS).filter(
    (k) => !(k in TABLE_FRESHNESS_QUERIES),
  );
  const cacheRows = await db
    .prepare(`SELECT key, updated_at FROM cache WHERE key IN (${cacheOnlyKeys.map(() => '?').join(',')})`)
    .bind(...cacheOnlyKeys)
    .all<{ key: string; updated_at: number }>();
  const cacheMap = new Map((cacheRows.results ?? []).map(r => [r.key, r.updated_at]));

  const caches: Record<string, CacheStatus> = {};
  let worstRatio = 0;

  for (const [key, maxAge] of Object.entries(CACHE_FRESHNESS_THRESHOLDS)) {
    let ageSeconds: number | null;

    if (key in TABLE_FRESHNESS_QUERIES) {
      try {
        const row = await db
          .prepare(TABLE_FRESHNESS_QUERIES[key])
          .bind(now)
          .first<{ age: number | null }>();
        ageSeconds = row?.age ?? null;
      } catch {
        ageSeconds = null;
      }
    } else {
      const updatedAt = cacheMap.get(key);
      ageSeconds = updatedAt != null ? now - updatedAt : null;
    }

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

/** Safely parse JSON, returning fallback on failure */
export function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (json == null) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

/** Validates a stablecoin ID: numeric DefiLlama IDs or prefixed commodity/CG IDs */
export function isValidStablecoinId(id: string): boolean {
  return /^\d+$/.test(id) || /^(?:gold|silver|cg)-/.test(id);
}

// --- Shared response builders ---

/** Build a JSON error response. Replaces inline `new Response(JSON.stringify({ error }), ...)` calls. */
export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Parse an integer query parameter with default, min, and max bounds. */
export function parseIntParam(
  value: string | null | undefined,
  defaultVal: number,
  min: number,
  max: number,
): number {
  if (value == null) return defaultVal;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultVal : Math.min(max, Math.max(min, parsed));
}

/** Build a JSON success response with optional extra headers. */
export function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
  });
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

    const headers = addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    }, cached.updatedAt, maxAgeSec);

    // Inject _meta into plain-object responses (not arrays)
    try {
      const parsed: unknown = JSON.parse(cached.value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        (parsed as Record<string, unknown>)._meta = buildFreshnessMeta(cached.updatedAt, maxAgeSec);
        return new Response(JSON.stringify(parsed), { headers });
      }
    } catch {
      // If JSON parse fails, fall through to raw response
    }

    return new Response(cached.value, { headers });
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
