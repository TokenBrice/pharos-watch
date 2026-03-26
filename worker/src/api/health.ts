import {
  withErrorHandler,
  buildCacheStatuses,
  jsonResponse,
} from "../lib/api-utils";
import { getCircuitStates, type CircuitRecord } from "../lib/circuit-breaker";
import { buildInClause } from "../lib/db";
import { CIRCUIT_SOURCE } from "../lib/constants";
import type { HealthResponse, TelegramHealthSummary } from "@shared/types/status";
import {
  buildMintBurnSyncHealth,
  evaluateMintBurnFreshness,
  resolveMintBurnFreshnessConfig,
  type MintBurnFreshnessConfig,
} from "../lib/mint-burn-health-config";
import { queryBlacklistGapMetrics } from "../lib/blacklist-gaps";

interface HealthOptions {
  mintBurnConfig?: MintBurnFreshnessConfig;
}

const DEFAULT_CIRCUIT_RECORD: CircuitRecord = {
  state: "closed",
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  openedAt: null,
};

const MINT_BURN_CRON_JOB = "sync-mint-burn";

export const handleHealth = withErrorHandler("health", async (db: D1Database, options?: HealthOptions): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000);
  const mintBurnConfig = options?.mintBurnConfig ?? resolveMintBurnFreshnessConfig();
  const warnings: string[] = [];

  let dbHealthy = true;
  try {
    await db.prepare("SELECT 1").first();
  } catch (err) {
    dbHealthy = false;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[health] DB health sentinel failed:", err);
    warnings.push(`db-unhealthy: ${message}`);
  }

  let caches: HealthResponse["caches"] = {};
  let worstRatioMut = 0;
  if (dbHealthy) {
    const { caches: cacheStatuses, worstRatio, failures, statusFloor, warnings: cacheWarnings } = await buildCacheStatuses(db, now);
    caches = cacheStatuses;
    worstRatioMut = Number.isFinite(worstRatio) ? worstRatio : 99;
    if (statusFloor === "stale" && worstRatioMut < 2.1) {
      worstRatioMut = 2.1;
    } else if (statusFloor === "degraded" && worstRatioMut < 1.6) {
      worstRatioMut = 1.6;
    }
    if (failures.length > 0) {
      warnings.push(
        `cache-freshness-query-failed: ${failures.map((failure) => failure.key).join(", ")}`,
      );
    }
    warnings.push(...cacheWarnings);
  } else {
    worstRatioMut = 3;
  }

  let blacklist: HealthResponse["blacklist"] = {
    totalEvents: 0,
    missingAmounts: 0,
    recentMissingAmounts: 0,
    recentWindowSec: 0,
    missingRatio: 0,
  };
  if (dbHealthy) {
    try {
      const counts = await queryBlacklistGapMetrics(db, now);
      blacklist = {
        totalEvents: counts.totalEvents,
        missingAmounts: counts.missingAmounts,
        recentMissingAmounts: counts.recentMissingAmounts,
        recentWindowSec: counts.recentWindowSec,
        missingRatio: counts.missingRatio,
      };
    } catch (err) {
      warnings.push(`blacklist-query-failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[health] Failed to query blacklist counts:", err);
      if (worstRatioMut < 1.6) worstRatioMut = 1.6;
    }
  }

  let mintBurn: HealthResponse["mintBurn"] = {
    totalEvents: 0,
    latestEventTs: null,
    latestHourlyTs: null,
    freshnessAgeSec: null,
    majorStaleCount: 0,
    staleMajorSymbols: [],
    sync: {
      lastSuccessfulSyncAt: null,
      freshnessStatus: "stale",
      warning: dbHealthy ? "Mint/burn health data unavailable." : "Primary database unavailable.",
      criticalLaneHealthy: false,
    },
  };
  if (dbHealthy) {
    try {
      const majorSymbolInClause = buildInClause(mintBurnConfig.majorSymbols);
      const [counts, latestEvent, latestHourly, majorRows, latestRun, latestSuccessfulSyncAt] = await Promise.all([
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
           WHERE symbol IN (${majorSymbolInClause.sql})
           GROUP BY symbol`,
        )
        .bind(...majorSymbolInClause.binds)
        .all<{ symbol: string; latest: number | null }>(),
        db
          .prepare(
            `SELECT status
             FROM cron_runs
             WHERE job = ?
             ORDER BY started_at DESC
             LIMIT 1`,
          )
          .bind(MINT_BURN_CRON_JOB)
          .first<{ status: string | null }>(),
        db
          .prepare(
            "SELECT MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'",
          )
          .bind(MINT_BURN_CRON_JOB)
          .first<{ started_at: number | null }>()
          .then((row) => row?.started_at ?? null)
          .catch(() => null),
      ]);
      if (counts) {
        const latestBySymbol = new Map<string, number>();
        for (const row of majorRows.results ?? []) {
          if (row.latest != null) latestBySymbol.set(row.symbol, row.latest);
        }

        const sync = buildMintBurnSyncHealth(now, latestSuccessfulSyncAt, latestRun?.status ?? null);
        const rawFreshness = evaluateMintBurnFreshness(now, latestBySymbol, mintBurnConfig);
        const actionableMajorStaleness =
          sync.freshnessStatus !== "fresh" || !sync.criticalLaneHealthy;
        const staleMajorSymbols = actionableMajorStaleness ? rawFreshness.staleMajorSymbols : [];

        const latestEventTs = latestEvent?.latest ?? null;
        mintBurn = {
          totalEvents: counts.total,
          latestEventTs,
          latestHourlyTs: latestHourly?.latest ?? null,
          freshnessAgeSec: latestEventTs == null ? null : Math.max(0, now - latestEventTs),
          majorStaleCount: staleMajorSymbols.length,
          staleMajorSymbols,
          sync,
        };

        if (sync.freshnessStatus === "stale" && worstRatioMut < 2.1) {
          worstRatioMut = 2.1;
        } else if (
          (sync.freshnessStatus === "degraded" || latestRun?.status === "error" || latestRun?.status === "degraded")
          && worstRatioMut < 1.6
        ) {
          worstRatioMut = 1.6;
        }
      }
    } catch (err) {
      warnings.push(`mint-burn-query-failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[health] Failed to query mint/burn counts:", err);
      if (worstRatioMut < 1.6) worstRatioMut = 1.6;
    }
  }

  // Check circuit breaker states
  let circuits: Record<string, CircuitRecord> = {};
  if (dbHealthy) {
    try {
      circuits = await getCircuitStates(db);
      for (const source of Object.values(CIRCUIT_SOURCE)) {
        if (!circuits[source]) {
          circuits[source] = { ...DEFAULT_CIRCUIT_RECORD };
        }
      }
      const openCircuitCount = Object.values(circuits).filter((c) => c.state === "open").length;
      if (openCircuitCount >= 3 && worstRatioMut < 1.6) {
        worstRatioMut = 1.6; // degraded
      }
    } catch (err) {
      warnings.push(`circuit-query-failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[health] Failed to query circuit states:", err);
      if (worstRatioMut < 1.6) worstRatioMut = 1.6;
    }
  }

  // Lightweight telegram summary — silently null if tables are not migrated
  let telegramSummary: TelegramHealthSummary | null = null;
  if (dbHealthy) {
    try {
      const [chatCount, pendingCount, lastDispatch] = await Promise.all([
        db.prepare("SELECT COUNT(*) AS n FROM telegram_subscribers").first<{ n: number }>(),
        db.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts").first<{ n: number }>(),
        db
          .prepare(
            "SELECT started_at, status FROM cron_runs WHERE job = 'dispatch-telegram-alerts' ORDER BY started_at DESC LIMIT 1",
          )
          .first<{ started_at: number; status: string }>(),
      ]);
      telegramSummary = {
        totalChats: chatCount?.n ?? 0,
        pendingDeliveries: pendingCount?.n ?? 0,
        lastDispatchAt: lastDispatch?.started_at ?? null,
        lastDispatchStatus: lastDispatch?.status ?? null,
      };
    } catch {
      // Telegram tables may not be migrated yet — silently null
    }
  }

  const status: HealthResponse["status"] =
    worstRatioMut > 2 ? "stale" : worstRatioMut > 1.5 ? "degraded" : "healthy";

  const body: HealthResponse = { status, timestamp: now, warnings, caches, blacklist, mintBurn, circuits, telegramSummary };

  return jsonResponse(body, { "Cache-Control": "no-store" });
});
