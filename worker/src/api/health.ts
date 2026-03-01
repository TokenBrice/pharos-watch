import { withErrorHandler, buildCacheStatuses, type CacheStatus } from "../lib/api-utils";
import { getCircuitStates, type CircuitRecord } from "../lib/circuit-breaker";

interface HealthResponse {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  caches: Record<string, CacheStatus>;
  blacklist: { totalEvents: number; missingAmounts: number };
  circuits: Record<string, CircuitRecord>;
}

export const handleHealth = withErrorHandler("health", async (db: D1Database): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000);
  const { caches, worstRatio } = await buildCacheStatuses(db, now);
  let worstRatioMut = worstRatio;

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
    if (dexRatio > worstRatioMut) worstRatioMut = dexRatio;
    caches["dex-liquidity"] = { ageSeconds: dexAgeSeconds, maxAge: dexMaxAge, healthy: dexRatio <= 1.5 };
  } catch {
    // dex_liquidity table may not exist yet
  }

  // Check yield_data table freshness
  try {
    const yieldAge = await db
      .prepare("SELECT MIN(? - updated_at) as age FROM yield_data")
      .bind(now)
      .first<{ age: number | null }>();
    const yieldMaxAge = 7200; // 2 hours
    const yieldAgeSeconds = yieldAge?.age ?? null;
    const yieldRatio = yieldAgeSeconds != null ? yieldAgeSeconds / yieldMaxAge : Infinity;
    if (yieldRatio > worstRatioMut) worstRatioMut = yieldRatio;
    caches["yield-data"] = { ageSeconds: yieldAgeSeconds, maxAge: yieldMaxAge, healthy: yieldRatio <= 1.5 };
  } catch {
    // yield_data table may not exist yet
  }

  // Check circuit breaker states
  let circuits: Record<string, CircuitRecord> = {};
  try {
    circuits = await getCircuitStates(db);
    const hasOpenCircuit = Object.values(circuits).some((c) => c.state === "open");
    if (hasOpenCircuit && worstRatioMut < 1.6) {
      worstRatioMut = 1.6; // degraded
    }
  } catch {
    // Non-blocking
  }

  const status: HealthResponse["status"] =
    worstRatioMut > 2 ? "stale" : worstRatioMut > 1.5 ? "degraded" : "healthy";

  const body: HealthResponse = { status, timestamp: now, caches, blacklist, circuits };

  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
});
