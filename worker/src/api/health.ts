import { withErrorHandler, buildCacheStatuses, type CacheStatus, jsonResponse } from "../lib/api-utils";
import { getCircuitStates, type CircuitRecord } from "../lib/circuit-breaker";

interface HealthResponse {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  caches: Record<string, CacheStatus>;
  blacklist: { totalEvents: number; missingAmounts: number };
  mintBurn: { totalEvents: number };
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

  let mintBurn = { totalEvents: 0 };
  try {
    const counts = await db
      .prepare(
        `SELECT
           COALESCE(SUM(mint_count + burn_count), 0) as total
         FROM mint_burn_hourly`,
      )
      .first<{ total: number }>();
    if (counts) {
      mintBurn = { totalEvents: counts.total };
    }
  } catch (err) {
    console.error("[health] Failed to query mint/burn counts:", err);
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

  const body: HealthResponse = { status, timestamp: now, caches, blacklist, mintBurn, circuits };

  return jsonResponse(body, { "Cache-Control": "no-store" });
});
