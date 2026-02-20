import { withErrorHandler } from "../lib/api-utils";
import { CACHE_FRESHNESS_THRESHOLDS } from "../lib/constants";

interface CacheStatus {
  ageSeconds: number | null;
  maxAge: number;
  healthy: boolean;
}

interface HealthResponse {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  caches: Record<string, CacheStatus>;
  blacklist: { totalEvents: number; missingAmounts: number };
}

export const handleHealth = withErrorHandler("health", async (db: D1Database): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000);
  // Batch query all cache keys at once
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

    caches[key] = {
      ageSeconds,
      maxAge,
      healthy: ratio <= 1.5,
    };
  }

  let blacklist = { totalEvents: 0, missingAmounts: 0 };
  try {
    const counts = await db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) as missing
         FROM blacklist_events`
      )
      .first<{ total: number; missing: number }>();
    if (counts) {
      blacklist = { totalEvents: counts.total, missingAmounts: counts.missing };
    }
  } catch (err) {
    console.error("[health] Failed to query blacklist counts:", err);
  }

  // Check dex_liquidity table freshness (runs every 6h)
  try {
    const dexAge = await db
      .prepare("SELECT MIN(? - updated_at) as age FROM dex_liquidity WHERE liquidity_score > 0")
      .bind(now)
      .first<{ age: number | null }>();
    const dexMaxAge = 43200; // 12 hours
    const dexAgeSeconds = dexAge?.age ?? null;
    const dexRatio = dexAgeSeconds != null ? dexAgeSeconds / dexMaxAge : Infinity;
    if (dexRatio > worstRatio) worstRatio = dexRatio;
    caches["dex-liquidity"] = { ageSeconds: dexAgeSeconds, maxAge: dexMaxAge, healthy: dexRatio <= 1.5 };
  } catch {
    // dex_liquidity table may not exist yet
  }

  const status: HealthResponse["status"] =
    worstRatio > 2 ? "stale" : worstRatio > 1.5 ? "degraded" : "healthy";

  const body: HealthResponse = { status, timestamp: now, caches, blacklist };

  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
});
