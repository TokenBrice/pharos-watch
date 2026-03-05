import { withErrorHandler, buildCacheStatuses, type CacheStatus, jsonResponse } from "../lib/api-utils";
import { getCircuitStates, type CircuitRecord } from "../lib/circuit-breaker";
import {
  evaluateMintBurnFreshness,
  resolveMintBurnFreshnessConfig,
  type MintBurnFreshnessConfig,
} from "../lib/mint-burn-health-config";
import { queryBlacklistGapMetrics } from "../lib/blacklist-gaps";

interface HealthResponse {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  caches: Record<string, CacheStatus>;
  blacklist: { totalEvents: number; missingAmounts: number };
  mintBurn: {
    totalEvents: number;
    latestEventTs: number | null;
    latestHourlyTs: number | null;
    freshnessAgeSec: number | null;
    majorStaleCount: number;
    staleMajorSymbols: string[];
  };
  circuits: Record<string, CircuitRecord>;
}

interface HealthOptions {
  mintBurnConfig?: MintBurnFreshnessConfig;
}

export const handleHealth = withErrorHandler("health", async (db: D1Database, options?: HealthOptions): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000);
  const mintBurnConfig = options?.mintBurnConfig ?? resolveMintBurnFreshnessConfig();
  const { caches, worstRatio } = await buildCacheStatuses(db, now);
  let worstRatioMut = worstRatio;

  let blacklist = { totalEvents: 0, missingAmounts: 0 };
  try {
    const counts = await queryBlacklistGapMetrics(db, now);
    blacklist = { totalEvents: counts.totalEvents, missingAmounts: counts.missingAmounts };
  } catch (err) {
    console.error("[health] Failed to query blacklist counts:", err);
  }

  let mintBurn: HealthResponse["mintBurn"] = {
    totalEvents: 0,
    latestEventTs: null,
    latestHourlyTs: null,
    freshnessAgeSec: null,
    majorStaleCount: 0,
    staleMajorSymbols: [],
  };
  try {
    const [counts, latestEvent, latestHourly, majorRows] = await Promise.all([
      db
      .prepare(
        `SELECT
           COALESCE(SUM(mint_count + burn_count), 0) as total
         FROM mint_burn_hourly`,
      )
      .first<{ total: number }>(),
      db
        .prepare("SELECT MAX(timestamp) as latest FROM mint_burn_events")
        .first<{ latest: number | null }>(),
      db
        .prepare("SELECT MAX(hour_ts) as latest FROM mint_burn_hourly")
        .first<{ latest: number | null }>(),
      db
      .prepare(
        `SELECT symbol, MAX(timestamp) as latest
         FROM mint_burn_events
         WHERE symbol IN (${mintBurnConfig.majorSymbols.map(() => "?").join(",")})
         GROUP BY symbol`,
      )
      .bind(...mintBurnConfig.majorSymbols)
      .all<{ symbol: string; latest: number | null }>(),
    ]);
    if (counts) {
      const latestBySymbol = new Map<string, number>();
      for (const row of majorRows.results ?? []) {
        if (row.latest != null) latestBySymbol.set(row.symbol, row.latest);
      }

      const freshness = evaluateMintBurnFreshness(now, latestBySymbol, mintBurnConfig);

      const latestEventTs = latestEvent?.latest ?? null;
      mintBurn = {
        totalEvents: counts.total,
        latestEventTs,
        latestHourlyTs: latestHourly?.latest ?? null,
        freshnessAgeSec: latestEventTs == null ? null : Math.max(0, now - latestEventTs),
        majorStaleCount: freshness.staleMajorSymbols.length,
        staleMajorSymbols: freshness.staleMajorSymbols,
      };

      if (freshness.criticalStaleCount > 0 && worstRatioMut < 2.1) {
        worstRatioMut = 2.1; // stale
      }
    }
  } catch (err) {
    console.error("[health] Failed to query mint/burn counts:", err);
  }

  if (mintBurn.majorStaleCount > 0 && worstRatioMut < 1.6) {
    worstRatioMut = 1.6; // degraded
  }
  if (mintBurn.majorStaleCount >= 3 && worstRatioMut < 2.1) {
    worstRatioMut = 2.1; // stale
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
