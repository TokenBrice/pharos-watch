import { getCache } from "./db-cache";
import { buildFreshnessMeta, addFreshnessHeaders } from "./api-freshness";
import { errorResponse, withErrorHandler } from "./api-response";

export function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (json == null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function safeJsonParseWithContext<T>(
  json: string | null | undefined,
  fallback: T,
  context: string,
): T {
  if (json == null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    console.warn(
      `[cache] Failed to parse persisted JSON (${context}):`,
      err instanceof Error ? err.message : String(err),
    );
    return fallback;
  }
}

export type CachedJsonReadResult<T> =
  | { status: "missing" }
  | { status: "ok"; data: T }
  | { status: "malformed"; message: string };

export function readCachedJson<T>(
  endpoint: string,
  cacheKey: string,
  cached: { value: string } | null,
): CachedJsonReadResult<T> {
  if (!cached) {
    return { status: "missing" };
  }

  try {
    return { status: "ok", data: JSON.parse(cached.value) as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cache] Failed to parse ${endpoint} cached payload (${cacheKey}):`, message);
    return { status: "malformed", message };
  }
}

export function readCachedJsonOr503<T>(
  endpoint: string,
  cacheKey: string,
  cached: { value: string },
): { ok: true; data: T } | { ok: false; response: Response } {
  const parsed = readCachedJson<T>(endpoint, cacheKey, cached);
  if (parsed.status === "ok") {
    return { ok: true, data: parsed.data };
  }
  return {
    ok: false,
    response: errorResponse(503, `Cached ${cacheKey} payload is malformed`),
  };
}

export function createCacheHandler(
  endpoint: string,
  cacheKey: string,
  cacheControl: string,
  maxAgeSec: number,
): (db: D1Database) => Promise<Response> {
  return withErrorHandler(endpoint, async (db: D1Database): Promise<Response> => {
    const cached = await getCache(db, cacheKey);
    if (!cached) {
      return errorResponse(503, "Data not yet available");
    }

    const headers = addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    }, cached.updatedAt, maxAgeSec);

    const parsed = readCachedJsonOr503<unknown>(endpoint, cacheKey, cached);
    if (!parsed.ok) {
      return parsed.response;
    }
    if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
      (parsed.data as Record<string, unknown>)._meta = buildFreshnessMeta(cached.updatedAt, maxAgeSec);
      return new Response(JSON.stringify(parsed.data), { headers });
    }

    return new Response(cached.value, { headers });
  });
}
