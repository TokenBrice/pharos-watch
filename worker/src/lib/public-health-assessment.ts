import {
  countPublicImpactOpenCircuits,
  getCircuitImpactStatus,
  getOverallCacheImpactStatus,
  getPublicMintBurnStatus,
  maxPublicStatus,
} from "@shared/lib/public-health";
import type { HealthResponse } from "@shared/types/status";
import { buildCacheStatuses, type CacheFreshnessDiagnostic, type CacheStatusFailure } from "./api-utils";
import { queryBlacklistGapMetrics, type BlacklistGapMetrics } from "./blacklist-gaps";
import {
  filterStaleLiveReserveCircuitStates,
  getCircuitStates,
  type CircuitRecord,
} from "./circuit-breaker";
import { CIRCUIT_SOURCE } from "./constants";
import { buildMintBurnSyncHealth } from "./mint-burn-health-config";

const DEFAULT_CIRCUIT_RECORD: CircuitRecord = {
  state: "closed",
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  openedAt: null,
};

const MINT_BURN_CRON_JOB = "sync-mint-burn";

const EMPTY_BLACKLIST_HEALTH: HealthResponse["blacklist"] = {
  totalEvents: 0,
  missingAmounts: 0,
  recentMissingAmounts: 0,
  recentWindowSec: 0,
  missingRatio: 0,
};

const EMPTY_MINT_BURN_HEALTH: HealthResponse["mintBurn"] = {
  totalEvents: null,
  latestEventTs: null,
  latestHourlyTs: null,
  freshnessAgeSec: null,
  majorStaleCount: 0,
  staleMajorSymbols: [],
  sync: {
    lastSuccessfulSyncAt: null,
    freshnessStatus: "stale",
    warning: "Mint/burn health data unavailable.",
    criticalLaneHealthy: false,
  },
};

export interface PublicHealthAssessment {
  dbHealthy: boolean;
  overallStatus: HealthResponse["status"];
  warnings: string[];
  caches: HealthResponse["caches"];
  cacheImpactStatus: HealthResponse["status"];
  worstCacheRatio: number;
  cacheFailures: CacheStatusFailure[];
  cacheDiagnostics: CacheFreshnessDiagnostic[];
  cacheWarnings: string[];
  blacklist: HealthResponse["blacklist"];
  blacklistMetrics: BlacklistGapMetrics | null;
  blacklistQueryError: string | null;
  mintBurn: HealthResponse["mintBurn"];
  mintBurnImpactStatus: HealthResponse["status"];
  mintBurnQueryError: string | null;
  mintBurnLastRunStatus: string | null;
  mintBurnBootstrap: boolean;
  circuits: Record<string, CircuitRecord>;
  openCircuitCount: number;
  circuitImpactStatus: HealthResponse["status"];
  circuitQueryError: string | null;
}

function publicHealthErrorMessage(kind: "blacklist" | "circuit" | "db" | "mint-burn"): string {
  switch (kind) {
    case "blacklist":
      return "Blacklist health data unavailable.";
    case "circuit":
      return "Circuit breaker diagnostics unavailable.";
    case "db":
      return "Primary database unavailable.";
    case "mint-burn":
      return "Mint/burn health data unavailable.";
  }
}

function completeCircuitStates(
  circuits: Record<string, CircuitRecord>,
): Record<string, CircuitRecord> {
  const completed = filterStaleLiveReserveCircuitStates(circuits);

  for (const source of Object.values(CIRCUIT_SOURCE)) {
    if (!completed[source]) {
      completed[source] = { ...DEFAULT_CIRCUIT_RECORD };
    }
  }

  return completed;
}

async function checkDbHealth(
  db: D1Database,
  logPrefix: string,
): Promise<{ dbHealthy: boolean; warning: string | null }> {
  try {
    await db.prepare("SELECT 1").first();
    return { dbHealthy: true, warning: null };
  } catch (err) {
    console.error(`[${logPrefix}] DB health sentinel failed:`, err);
    return {
      dbHealthy: false,
      warning: "db-unhealthy",
    };
  }
}

async function loadMintBurnHealth(
  db: D1Database,
  now: number,
): Promise<{
  mintBurn: HealthResponse["mintBurn"];
  mintBurnImpactStatus: HealthResponse["status"];
  mintBurnQueryError: string | null;
  mintBurnLastRunStatus: string | null;
  mintBurnBootstrap: boolean;
}> {
  try {
    const [latestRun, latestSuccessfulSyncAt] = await Promise.all([
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

    const sync = buildMintBurnSyncHealth(now, latestSuccessfulSyncAt, latestRun?.status ?? null);
    const mintBurn: HealthResponse["mintBurn"] = {
      totalEvents: null,
      latestEventTs: null,
      latestHourlyTs: null,
      freshnessAgeSec: null,
      majorStaleCount: 0,
      staleMajorSymbols: [],
      sync,
    };

    return {
      mintBurn,
      mintBurnImpactStatus: getPublicMintBurnStatus(sync),
      mintBurnQueryError: null,
      mintBurnLastRunStatus: latestRun?.status ?? null,
      mintBurnBootstrap: latestRun?.status == null && latestSuccessfulSyncAt == null,
    };
  } catch (err) {
    console.error("[health] Mint/burn health query failed:", err);
    return {
      mintBurn: { ...EMPTY_MINT_BURN_HEALTH },
      mintBurnImpactStatus: "degraded",
      mintBurnQueryError: publicHealthErrorMessage("mint-burn"),
      mintBurnLastRunStatus: null,
      mintBurnBootstrap: false,
    };
  }
}

export async function assessPublicHealth(
  db: D1Database,
  now: number,
  options?: {
    logPrefix?: string;
  },
): Promise<PublicHealthAssessment> {
  const logPrefix = options?.logPrefix ?? "health";
  const warnings: string[] = [];

  const { dbHealthy, warning: dbWarning } = await checkDbHealth(db, logPrefix);
  if (!dbHealthy) {
    if (dbWarning) warnings.push(dbWarning);
    return {
      dbHealthy: false,
      overallStatus: "stale",
      warnings,
      caches: {},
      cacheImpactStatus: "stale",
      worstCacheRatio: 0,
      cacheFailures: [],
      cacheDiagnostics: [],
      cacheWarnings: [],
      blacklist: { ...EMPTY_BLACKLIST_HEALTH },
      blacklistMetrics: null,
      blacklistQueryError: null,
      mintBurn: {
        ...EMPTY_MINT_BURN_HEALTH,
        sync: {
          ...EMPTY_MINT_BURN_HEALTH.sync,
          warning: "Primary database unavailable.",
        },
      },
      mintBurnImpactStatus: "stale",
      mintBurnQueryError: null,
      mintBurnLastRunStatus: null,
      mintBurnBootstrap: false,
      circuits: {},
      openCircuitCount: 0,
      circuitImpactStatus: "healthy",
      circuitQueryError: null,
    };
  }

  const [
    cacheAssessment,
    blacklistResult,
    mintBurnResult,
    circuitResult,
  ] = await Promise.all([
    buildCacheStatuses(db, now),
    queryBlacklistGapMetrics(db, now)
      .then((metrics) => ({ metrics, error: null as string | null }))
      .catch((err) => {
        console.error(`[${logPrefix}] Failed to query blacklist counts:`, err);
        return { metrics: null, error: publicHealthErrorMessage("blacklist") };
      }),
    loadMintBurnHealth(db, now),
    getCircuitStates(db)
      .then((circuits) => ({ circuits: completeCircuitStates(circuits), error: null as string | null }))
      .catch((err) => {
        console.error(`[${logPrefix}] Failed to query circuit states:`, err);
        return { circuits: {}, error: publicHealthErrorMessage("circuit") };
      }),
  ]);

  const cacheImpactStatus = getOverallCacheImpactStatus(cacheAssessment.caches);
  if (cacheAssessment.failures.length > 0) {
    warnings.push(
      `cache-freshness-query-failed: ${cacheAssessment.failures.map((failure) => failure.key).join(", ")}`,
    );
  }
  warnings.push(...cacheAssessment.warnings);

  const blacklist = blacklistResult.metrics == null
    ? { ...EMPTY_BLACKLIST_HEALTH }
    : {
        totalEvents: blacklistResult.metrics.totalEvents,
        missingAmounts: blacklistResult.metrics.missingAmounts,
        recentMissingAmounts: blacklistResult.metrics.recentMissingAmounts,
        recentWindowSec: blacklistResult.metrics.recentWindowSec,
        missingRatio: blacklistResult.metrics.missingRatio,
      };
  if (blacklistResult.error) {
    warnings.push("blacklist-query-failed");
  }

  if (mintBurnResult.mintBurnQueryError) {
    warnings.push("mint-burn-query-failed");
  }

  const openCircuitCount = countPublicImpactOpenCircuits(circuitResult.circuits);
  const circuitImpactStatus = circuitResult.error
    ? "degraded"
    : getCircuitImpactStatus(openCircuitCount);
  if (circuitResult.error) {
    warnings.push("circuit-query-failed");
  }

  const overallStatus = maxPublicStatus(
    cacheImpactStatus,
    mintBurnResult.mintBurnImpactStatus,
    circuitImpactStatus,
    blacklistResult.error ? "degraded" : "healthy",
  );

  return {
    dbHealthy: true,
    overallStatus,
    warnings,
    caches: cacheAssessment.caches,
    cacheImpactStatus,
    worstCacheRatio: Number.isFinite(cacheAssessment.worstRatio) ? cacheAssessment.worstRatio : 99,
    cacheFailures: cacheAssessment.failures,
    cacheDiagnostics: cacheAssessment.diagnostics,
    cacheWarnings: cacheAssessment.warnings,
    blacklist,
    blacklistMetrics: blacklistResult.metrics,
    blacklistQueryError: blacklistResult.error,
    mintBurn: mintBurnResult.mintBurn,
    mintBurnImpactStatus: mintBurnResult.mintBurnImpactStatus,
    mintBurnQueryError: mintBurnResult.mintBurnQueryError,
    mintBurnLastRunStatus: mintBurnResult.mintBurnLastRunStatus,
    mintBurnBootstrap: mintBurnResult.mintBurnBootstrap,
    circuits: circuitResult.circuits,
    openCircuitCount,
    circuitImpactStatus,
    circuitQueryError: circuitResult.error,
  };
}
