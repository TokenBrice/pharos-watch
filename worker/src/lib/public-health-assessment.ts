import { getBlacklistGapStatus } from "@shared/lib/status-thresholds";
import { getD1CapacityImpactStatus } from "@shared/lib/d1-capacity";
import {
  countPublicImpactOpenCircuits,
  getCircuitImpactStatus,
  getOverallCacheImpactStatus,
  getPublicMintBurnStatus,
  maxPublicStatus,
} from "@shared/lib/public-health";
import { CACHE_UPSTREAM_PROVIDER } from "@shared/lib/status-metadata";
import type { CacheStatus, HealthResponse, StablecoinPublicationHealth } from "@shared/types/status";
import { buildCacheStatuses, type CacheFreshnessDiagnostic, type CacheStatusFailure } from "./api-utils";
import {
  BLACKLIST_GAP_METRICS_DIAGNOSTIC_CACHE_TTL_SEC,
  BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC,
  queryBlacklistGapMetrics,
  type BlacklistGapMetrics,
} from "./blacklist-gaps";
import {
  filterInactiveCircuitStates,
  getCircuitStates,
  type CircuitRecord,
} from "./circuit-breaker";
import { CIRCUIT_SOURCE } from "./constants";
import { buildMintBurnSyncHealth } from "./mint-burn-health-config";
import { logWorkerEvent } from "./structured-log";
import { loadAlertBrokerSummary, type AlertBrokerSummary } from "./alert-broker";
import { loadCachedD1CapacityAssessment } from "./status/d1-capacity-store";
import {
  loadStablecoinPublicationHealth,
  unknownStablecoinPublicationHealth,
} from "./stablecoin-publication-health";

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
  queryErrors: {
    latestSuccessfulSyncAt: null,
    rowCount: null,
  },
  sync: {
    lastSuccessfulSyncAt: null,
    freshnessStatus: "stale",
    warning: "Mint/burn health data unavailable.",
    criticalLaneHealthy: false,
  },
};

const EMPTY_ALERT_BROKER_SUMMARY: AlertBrokerSummary = {
  activeCount: 0,
  pendingCount: 0,
  criticalActiveCount: 0,
  failedDeliveryCount: 0,
  missingTargetCount: 0,
  oldestActiveAt: null,
  activeConditionKeys: [],
  queryFailed: false,
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
  d1Capacity: HealthResponse["d1Capacity"];
  d1CapacityImpactStatus: HealthResponse["status"];
  d1CapacityQueryError: string | null;
  alertBroker: AlertBrokerSummary;
  alertBrokerImpactStatus: HealthResponse["status"];
  stablecoinPublication: StablecoinPublicationHealth;
  stablecoinPublicationImpactStatus: HealthResponse["status"];
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
  const completed = filterInactiveCircuitStates(circuits);

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
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "db_health_sentinel_failed",
      route: logPrefix,
      message: "DB health sentinel failed",
      error: err,
    });
    return {
      dbHealthy: false,
      warning: "db-unhealthy",
    };
  }
}

function readMintBurnWatchdogRowCount(row: { item_count: number | null; metadata: string | null } | null): number | null {
  if (typeof row?.item_count === "number") return row.item_count;
  if (!row?.metadata) return null;

  try {
    const metadata = JSON.parse(row.metadata) as { rowCount?: unknown };
    return typeof metadata.rowCount === "number" ? metadata.rowCount : null;
  } catch {
    return null;
  }
}

type MintBurnSubqueryName = keyof NonNullable<HealthResponse["mintBurn"]["queryErrors"]>;

type MintBurnSubqueryResult<T> =
  | { ok: true; value: T; error: null }
  | { ok: false; value: null; error: string };

function mintBurnSubqueryErrorMessage(name: MintBurnSubqueryName): string {
  switch (name) {
    case "latestSuccessfulSyncAt":
      return "Latest successful mint/burn sync timestamp unavailable.";
    case "rowCount":
      return "Mint/burn row-count diagnostics unavailable.";
  }
}

async function captureMintBurnSubquery<T>(
  name: MintBurnSubqueryName,
  run: () => Promise<T>,
): Promise<MintBurnSubqueryResult<T>> {
  try {
    return { ok: true, value: await run(), error: null };
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "mint_burn_health_subquery_failed",
      route: "health",
      job: MINT_BURN_CRON_JOB,
      source: name,
      message: mintBurnSubqueryErrorMessage(name),
      error: err,
    });
    return { ok: false, value: null, error: mintBurnSubqueryErrorMessage(name) };
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
    const [latestRun, latestSuccessfulSyncResult, totalEventsResult] = await Promise.all([
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
      captureMintBurnSubquery(
        "latestSuccessfulSyncAt",
        () =>
          db
            .prepare(
              "SELECT MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'",
            )
            .bind(MINT_BURN_CRON_JOB)
            .first<{ started_at: number | null }>()
            .then((row) => row?.started_at ?? null),
      ),
      // O(1) advisory row count from the daily growth watchdog's cron_runs
      // result. Avoids public health scans of mint_burn_events/mint_burn_hourly
      // while not relying on sqlite_sequence, which only tracks AUTOINCREMENT
      // tables and therefore cannot track mint_burn_events' TEXT primary key.
      captureMintBurnSubquery(
        "rowCount",
        () =>
          db
            .prepare(
              `SELECT item_count, metadata
               FROM cron_runs
               WHERE job = ? AND status IN ('ok', 'degraded')
               ORDER BY started_at DESC
               LIMIT 1`,
            )
            .bind("mint-burn-growth-watchdog")
            .first<{ item_count: number | null; metadata: string | null }>()
            .then(readMintBurnWatchdogRowCount),
      ),
    ]);

    const queryErrors: NonNullable<HealthResponse["mintBurn"]["queryErrors"]> = {
      latestSuccessfulSyncAt: latestSuccessfulSyncResult.error,
      rowCount: totalEventsResult.error,
    };
    const latestSuccessfulSyncAt = latestSuccessfulSyncResult.ok ? latestSuccessfulSyncResult.value : null;
    const totalEvents = totalEventsResult.ok ? totalEventsResult.value : null;
    const sync = buildMintBurnSyncHealth(now, latestSuccessfulSyncAt, latestRun?.status ?? null);
    const mintBurn: HealthResponse["mintBurn"] = {
      totalEvents,
      latestEventTs: null,
      latestHourlyTs: null,
      freshnessAgeSec: null,
      majorStaleCount: 0,
      staleMajorSymbols: [],
      queryErrors,
      sync,
    };
    const mintBurnQueryError = queryErrors.latestSuccessfulSyncAt
      ? publicHealthErrorMessage("mint-burn")
      : null;

    return {
      mintBurn,
      mintBurnImpactStatus: mintBurnQueryError ? "degraded" : getPublicMintBurnStatus(sync),
      mintBurnQueryError,
      mintBurnLastRunStatus: latestRun?.status ?? null,
      mintBurnBootstrap:
        !mintBurnQueryError && latestRun?.status == null && latestSuccessfulSyncAt == null,
    };
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "mint_burn_health_query_failed",
      route: "health",
      job: MINT_BURN_CRON_JOB,
      message: "Mint/burn health query failed",
      error: err,
    });
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
      d1Capacity: null,
      d1CapacityImpactStatus: "healthy",
      d1CapacityQueryError: null,
      alertBroker: { ...EMPTY_ALERT_BROKER_SUMMARY },
      alertBrokerImpactStatus: "stale",
      stablecoinPublication: unknownStablecoinPublicationHealth(),
      stablecoinPublicationImpactStatus: "healthy",
    };
  }

  const [
    cacheAssessment,
    blacklistResult,
    mintBurnResult,
    circuitResult,
    d1CapacityResult,
    alertBroker,
    stablecoinPublication,
  ] = await Promise.all([
    buildCacheStatuses(db, now),
    queryBlacklistGapMetrics(db, now, {
      includeDistributions: false,
      producerSnapshotTtlSec: BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC,
      cacheTtlSec: BLACKLIST_GAP_METRICS_DIAGNOSTIC_CACHE_TTL_SEC,
    })
      .then((metrics) => ({ metrics, error: null as string | null }))
      .catch((err) => {
        logWorkerEvent({
          scope: "status",
          level: "error",
          event: "blacklist_counts_query_failed",
          route: logPrefix,
          source: "blacklist-gaps",
          message: "Failed to query blacklist counts",
          error: err,
        });
        return { metrics: null, error: publicHealthErrorMessage("blacklist") };
      }),
    loadMintBurnHealth(db, now),
    getCircuitStates(db)
      .then((circuits) => ({ circuits: completeCircuitStates(circuits), error: null as string | null }))
      .catch((err) => {
        logWorkerEvent({
          scope: "status",
          level: "error",
          event: "circuit_states_query_failed",
          route: logPrefix,
          source: "circuit-breaker",
          message: "Failed to query circuit states",
          error: err,
        });
        return { circuits: {}, error: publicHealthErrorMessage("circuit") };
      }),
    loadCachedD1CapacityAssessment(db, now)
      .then((assessment) => ({ assessment, error: null as string | null }))
      .catch((err) => {
        logWorkerEvent({
          scope: "status",
          level: "warn",
          event: "d1_capacity_cache_query_failed",
          route: logPrefix,
          source: "d1-capacity",
          message: "Failed to load the cached D1 capacity assessment",
          error: err,
        });
        return { assessment: null, error: "D1 capacity assessment unavailable." };
      }),
    loadAlertBrokerSummary(db),
    loadStablecoinPublicationHealth(db),
  ]);

  const cachesWithProvider: Record<string, CacheStatus> = {};
  for (const [key, cache] of Object.entries(cacheAssessment.caches)) {
    cachesWithProvider[key] = {
      ...cache,
      upstreamProvider: CACHE_UPSTREAM_PROVIDER[key] ?? null,
    };
  }

  const cacheImpactStatus = getOverallCacheImpactStatus(cachesWithProvider);
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

  const d1CapacityImpactStatus = d1CapacityResult.error
    ? "degraded"
    : d1CapacityResult.assessment
      ? getD1CapacityImpactStatus(d1CapacityResult.assessment.thresholdState)
      : "healthy";
  if (d1CapacityResult.error) {
    warnings.push("d1-capacity-query-failed");
  } else if (d1CapacityResult.assessment?.thresholdState !== "normal" && d1CapacityResult.assessment) {
    warnings.push(
      `d1-capacity-${d1CapacityResult.assessment.thresholdState}:${d1CapacityResult.assessment.utilizationPercent}`,
    );
  }

  const alertBrokerImpactStatus = alertBroker.queryFailed || alertBroker.criticalActiveCount > 0
    ? "degraded"
    : alertBroker.activeCount > 0 || alertBroker.failedDeliveryCount > 0 || alertBroker.missingTargetCount > 0
      ? "degraded"
      : "healthy";
  if (alertBroker.queryFailed) warnings.push("alert-broker-query-failed");
  if (alertBroker.activeConditionKeys.length > 0) {
    warnings.push(`active-alert-conditions:${alertBroker.activeConditionKeys.join(",")}`);
  }
  if (alertBroker.failedDeliveryCount > 0) {
    warnings.push(`alert-delivery-failed:${alertBroker.failedDeliveryCount}`);
  }
  if (alertBroker.missingTargetCount > 0) {
    warnings.push(`alert-delivery-missing-target:${alertBroker.missingTargetCount}`);
  }

  const stablecoinPublicationImpactStatus = stablecoinPublication.status === "incomplete"
    ? "degraded"
    : "healthy";
  if (stablecoinPublication.status === "incomplete") {
    warnings.push(
      `stablecoin-publication-incomplete:${stablecoinPublication.missingActiveIds.join(",") || "count-mismatch"}`,
    );
  }

  const blacklistImpactStatus = blacklistResult.error
    ? "degraded"
    : blacklistResult.metrics
      ? getBlacklistGapStatus({
          missingRatio: blacklistResult.metrics.missingRatio,
          recentMissingAmounts: blacklistResult.metrics.recentMissingAmounts,
        })
      : "healthy";

  const overallStatus = maxPublicStatus(
    cacheImpactStatus,
    mintBurnResult.mintBurnImpactStatus,
    circuitImpactStatus,
    blacklistImpactStatus,
    d1CapacityImpactStatus,
    alertBrokerImpactStatus,
    stablecoinPublicationImpactStatus,
  );

  return {
    dbHealthy: true,
    overallStatus,
    warnings,
    caches: cachesWithProvider,
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
    d1Capacity: d1CapacityResult.assessment,
    d1CapacityImpactStatus,
    d1CapacityQueryError: d1CapacityResult.error,
    alertBroker,
    alertBrokerImpactStatus,
    stablecoinPublication,
    stablecoinPublicationImpactStatus,
  };
}
