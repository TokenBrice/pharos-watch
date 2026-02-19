import { getCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";

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

const FRESHNESS_THRESHOLDS: Record<string, number> = {
  stablecoins: 600,
  "stablecoin-charts": 600,
  "usds-status": 86400,
};

export const handleHealth = withErrorHandler("health", async (db: D1Database): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000);
  const caches: Record<string, CacheStatus> = {};
  let worstRatio = 0;

  for (const [key, maxAge] of Object.entries(FRESHNESS_THRESHOLDS)) {
    const cached = await getCache(db, key);
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
  } catch {
    // D1 query failed — leave defaults
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
