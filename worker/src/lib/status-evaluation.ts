import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_CACHE_RATIO_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import type {
  CronInFlight,
  CronRun,
  CronStatus,
  StatusCause,
  StatusResponse,
} from "@shared/types/status";
import { buildCacheStatuses } from "./api-utils";
import { buildInClause } from "./db";
import { computeReserveCompositionOverview } from "./live-reserves-store";
import {
  emptyDatasetFreshness,
  emptyReserveComposition,
  getDatasetFreshness,
  getTelegramBotStats,
} from "./status/derived-data";
import { emptyDataQuality, getDataQuality } from "./status/data-quality";
import {
  clampConfidence,
  reconcileStatusState,
  type StatusLevel,
} from "./status-reliability";
import { assessOnchainDataQuality } from "./status/onchain-data-quality";

const STATUS_SEVERITY: Record<StatusLevel, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

export interface RawStatusComputation {
  dbHealthy: boolean;
  availabilityStatus: StatusResponse["availabilityStatus"];
  dataQualityStatus: StatusResponse["dataQualityStatus"];
  rawOverallStatus: StatusLevel;
  confidence: number;
  causes: StatusResponse["causes"];
  caches: StatusResponse["caches"];
  crons: StatusResponse["crons"];
  dataQuality: StatusResponse["dataQuality"];
  telegramBot: StatusResponse["telegramBot"];
  sectionErrors: StatusResponse["sectionErrors"];
  datasetFreshness: StatusResponse["datasetFreshness"];
  summary: StatusResponse["summary"];
  reserveComposition: StatusResponse["reserveComposition"];
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function pushCause(bucket: StatusCause[], cause: StatusCause): void {
  bucket.push(cause);
}

function synthesizeOverallCauses(availability: StatusCause[], dataQuality: StatusCause[]): StatusCause[] {
  const sorted = [...availability, ...dataQuality].sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
  return sorted.slice(0, 12);
}

function scoreConfidence(input: {
  availabilityStatus: StatusLevel;
  dataQualityStatus: StatusLevel;
  unhealthyCrons: number;
  degradedCrons: number;
  missingPriceRatio: number;
  onchainMonitoringActive: boolean;
}): number {
  let confidence = 1;

  if (input.availabilityStatus === "degraded") confidence -= 0.12;
  if (input.availabilityStatus === "stale") confidence -= 0.28;
  if (input.dataQualityStatus === "degraded") confidence -= 0.12;
  if (input.dataQualityStatus === "stale") confidence -= 0.28;

  confidence -= Math.min(0.2, input.unhealthyCrons * 0.03);
  confidence -= Math.min(0.08, input.degradedCrons * 0.01);
  confidence -= Math.min(0.18, input.missingPriceRatio * 0.35);
  if (!input.onchainMonitoringActive) confidence -= 0.03;

  return Math.round(clampConfidence(confidence) * 1000) / 1000;
}

function maxStatus(a: StatusLevel, b: StatusLevel): StatusLevel {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

function parseMetadataObject(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function buildDbUnavailableRawStatus(): RawStatusComputation {
  const availabilityCauses: StatusCause[] = [{
    code: "db_unhealthy",
    layer: "availability",
    severity: "critical",
    message: "Primary database connectivity check failed; status is serving a degraded fallback snapshot.",
  }];
  const dataQualityCauses: StatusCause[] = [{
    code: "data_quality_skipped_db_unhealthy",
    layer: "data-quality",
    severity: "warning",
    message: "Data-quality loaders were skipped because the primary database connectivity check failed.",
  }];

  return {
    dbHealthy: false,
    availabilityStatus: "stale",
    dataQualityStatus: "stale",
    rawOverallStatus: "stale",
    confidence: 0.1,
    causes: {
      availability: availabilityCauses,
      dataQuality: dataQualityCauses,
      overall: synthesizeOverallCauses(availabilityCauses, dataQualityCauses),
    },
    caches: {},
    crons: {},
    dataQuality: emptyDataQuality(),
    telegramBot: null,
    sectionErrors: {},
    datasetFreshness: emptyDatasetFreshness(),
    summary: {
      unhealthyCrons: 0,
      degradedCrons: 0,
      cronErrors: 0,
      worstCacheRatio: 0,
    },
    reserveComposition: emptyReserveComposition(),
  };
}

export async function evaluateStatusAndPersist(
  db: D1Database,
  now: number,
): Promise<{
  raw: RawStatusComputation;
  effectiveStatus: StatusLevel;
}> {
  const raw = await computeRawStatus(db, now);
  const persisted = await reconcileStatusState(db, now, raw.rawOverallStatus, raw.confidence, raw.causes.overall);
  return {
    raw,
    effectiveStatus: persisted.effectiveStatus,
  };
}

export async function computeRawStatus(db: D1Database, now: number): Promise<RawStatusComputation> {
  let dbHealthy = true;
  try {
    await db.prepare("SELECT 1").first();
  } catch (err) {
    dbHealthy = false;
    console.error("[status] DB health sentinel failed:", err);
  }
  if (!dbHealthy) {
    return buildDbUnavailableRawStatus();
  }

  const {
    caches,
    worstRatio: rawWorstCacheRatio,
    failures: cacheFailures,
    statusFloor: cacheStatusFloor,
    warnings: cacheWarnings,
  } = await buildCacheStatuses(db, now);
  const worstCacheRatio = Number.isFinite(rawWorstCacheRatio) ? rawWorstCacheRatio : 99;

  const cronJobs = Object.keys(CRON_INTERVALS);
  const cronJobInClause = buildInClause(cronJobs);
  let cronRows: { results?: Array<{
    job: string;
    started_at: number;
    duration_ms: number;
    status: string;
    error: string | null;
    item_count: number | null;
    metadata: string | null;
  }> } = { results: [] };
  let cronHistoryQueryFailed = false;
  try {
    cronRows = await db
      .prepare(
        `SELECT job, started_at, duration_ms, status, error, item_count, metadata
         FROM (
           SELECT job, started_at, duration_ms, status, error, item_count, metadata,
                  ROW_NUMBER() OVER (PARTITION BY job ORDER BY started_at DESC) AS rn
           FROM cron_runs
           WHERE job IN (${cronJobInClause.sql})
         )
         WHERE rn <= 10
         ORDER BY started_at DESC`,
      )
      .bind(...cronJobInClause.binds)
      .all<{
        job: string;
        started_at: number;
        duration_ms: number;
        status: string;
        error: string | null;
        item_count: number | null;
        metadata: string | null;
      }>();
  } catch (err) {
    cronHistoryQueryFailed = true;
    console.error("[status] Failed to query cron history:", err);
  }

  let cronProgressByJob = new Map<string, CronInFlight>();
  let cronProgressQueryFailed = false;
  let cronLeaseByJob: Map<string, { leaseOwner: string; leaseUntil: number }> | null = null;
  let cronLeaseQueryFailed = false;
  try {
    const leaseRows = await db
      .prepare(
        `SELECT job, lease_owner, lease_until
           FROM cron_leases
           WHERE job IN (${cronJobInClause.sql})`,
      )
      .bind(...cronJobInClause.binds)
      .all<{
        job: string;
        lease_owner: string;
        lease_until: number;
      }>();

    cronLeaseByJob = new Map(
      (leaseRows.results ?? []).map((row) => [row.job, {
        leaseOwner: row.lease_owner,
        leaseUntil: row.lease_until,
      }]),
    );
  } catch (err) {
    cronLeaseQueryFailed = true;
    console.warn("[status] cron_leases unavailable:", err);
  }

  try {
    const progressRows = await db
      .prepare(
        `SELECT job, started_at, updated_at, stage, items_done, items_total, message, lease_owner, metadata
           FROM cron_run_progress
           WHERE job IN (${cronJobInClause.sql})`,
      )
      .bind(...cronJobInClause.binds)
      .all<{
        job: string;
        started_at: number;
        updated_at: number;
        stage: string | null;
        items_done: number | null;
        items_total: number | null;
        message: string | null;
        lease_owner: string | null;
        metadata: string | null;
      }>();

    const filteredProgressRows = (progressRows.results ?? []).filter((row) => {
      if (cronLeaseQueryFailed || cronLeaseByJob == null || !row.lease_owner) {
        return true;
      }

      const lease = cronLeaseByJob.get(row.job);
      return lease != null && lease.leaseOwner === row.lease_owner && lease.leaseUntil >= now;
    });

    cronProgressByJob = new Map(
      filteredProgressRows.map((row) => {
        const parsedMeta = parseMetadataObject(row.metadata);

        return [row.job, {
          startedAt: row.started_at,
          updatedAt: row.updated_at,
          ...(row.stage ? { stage: row.stage } : {}),
          ...(row.items_done != null ? { itemsDone: row.items_done } : {}),
          ...(row.items_total != null ? { itemsTotal: row.items_total } : {}),
          ...(row.message ? { message: row.message } : {}),
          ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
          ...(parsedMeta ? { metadata: parsedMeta } : {}),
          stale: false,
        } satisfies CronInFlight];
      }),
    );
  } catch (err) {
    cronProgressQueryFailed = true;
    console.warn("[status] cron_run_progress unavailable:", err);
  }

  const cronByJob = new Map<string, CronRun[]>();
  for (const row of cronRows.results ?? []) {
    const runs = cronByJob.get(row.job) ?? [];
    if (runs.length < 10) {
      const parsedMeta = parseMetadataObject(row.metadata);
      runs.push({
        startedAt: row.started_at,
        durationMs: row.duration_ms,
        status: row.status,
        ...(row.error ? { error: row.error } : {}),
        ...(row.item_count != null ? { itemCount: row.item_count } : {}),
        ...(parsedMeta ? { metadata: parsedMeta } : {}),
      });
      cronByJob.set(row.job, runs);
    }
  }

  const crons: Record<string, CronStatus> = {};
  let anyCronError = false;
  let unhealthyCrons = 0;
  let degradedCronRuns = 0;
  let cronErrorCount = 0;

  for (const [job, interval] of Object.entries(CRON_INTERVALS)) {
    const runs = cronByJob.get(job) ?? [];
    const lastRun = runs.length > 0 ? runs[0] : null;
    const inFlight = cronProgressByJob.get(job);
    const telemetryUnknown = cronHistoryQueryFailed;
    const inFlightFresh = inFlight != null && now - inFlight.updatedAt <= Math.max(300, interval);
    const isFresh = lastRun != null && now - lastRun.startedAt <= interval * 2;
    const hasFreshOk = runs.some((run) => run.status === "ok" && now - run.startedAt <= interval * 2);
    const availabilityHealthyFromLastRun =
      isFresh &&
      lastRun != null &&
      (lastRun.status === "ok" ||
        lastRun.status === "degraded" ||
        (lastRun.status === "skipped_locked" && hasFreshOk));
    const healthy = telemetryUnknown ? true : inFlightFresh || availabilityHealthyFromLastRun;
    const availabilityUnhealthy = !telemetryUnknown && !healthy;

    if (availabilityUnhealthy) unhealthyCrons++;
    if (!telemetryUnknown && lastRun?.status === "degraded" && isFresh) degradedCronRuns++;
    if (!telemetryUnknown && lastRun?.status === "error" && !inFlightFresh) {
      anyCronError = true;
      cronErrorCount++;
    }

    crons[job] = {
      lastRun,
      recentRuns: runs,
      expectedIntervalSec: interval,
      healthy,
      telemetryUnknown,
      inFlight: (() => {
        if (!inFlight) return null;
        return {
          ...inFlight,
          stale: now - inFlight.updatedAt > Math.max(300, interval),
        };
      })(),
    };
  }

  const dataQuality = dbHealthy ? await getDataQuality(db, now) : emptyDataQuality();
  const sectionErrors: StatusResponse["sectionErrors"] = {};
  let telegramBot: StatusResponse["telegramBot"] = null;
  if (dbHealthy) {
    try {
      telegramBot = await getTelegramBotStats(db, now);
    } catch (err) {
      console.warn("[status] Telegram bot stats unavailable:", err);
      sectionErrors.telegramBot = {
        code: "telegram_bot_stats_query_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const datasetFreshness = dbHealthy ? await getDatasetFreshness(db) : emptyDatasetFreshness();
  let reserveComposition = emptyReserveComposition();
  let reserveCompositionQueryFailed = false;
  try {
    reserveComposition = dbHealthy
      ? await computeReserveCompositionOverview(db, now)
      : emptyReserveComposition();
  } catch (err) {
    reserveCompositionQueryFailed = true;
    console.warn("[status] Reserve composition overview unavailable:", err);
    sectionErrors.reserveComposition = {
      code: "reserve_composition_query_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const reserveCompositionBootstrap = reserveComposition.configuredCoins > 0 && reserveComposition.lastSuccessAt == null;
  const missingPriceRatio =
    dataQuality.totalStablecoins > 0 ? dataQuality.missingPrices / dataQuality.totalStablecoins : 0;
  const blacklistMissingRatio = dataQuality.blacklistMissingRatio;
  const blacklistRecentMissing = dataQuality.blacklistRecentMissingAmounts;
  const hasActiveOnchainMonitor = dataQuality.onchainSupplyMonitoring === "active";
  const trackedOnchainCoins = hasActiveOnchainMonitor ? dataQuality.onchainSupplyTrackedCoins : 0;
  const onchainAssessment = assessOnchainDataQuality({
    monitoring: dataQuality.onchainSupplyMonitoring,
    trackedCoins: trackedOnchainCoins,
    staleSupply: hasActiveOnchainMonitor ? dataQuality.staleOnchainSupply : 0,
    staleRatio: hasActiveOnchainMonitor ? dataQuality.onchainStaleRatio : 0,
    divergences: hasActiveOnchainMonitor ? dataQuality.onchainSupplyDivergences : 0,
    divergenceRatio: hasActiveOnchainMonitor ? dataQuality.onchainDivergenceRatio : 0,
  });
  const reserveIssueCount = reserveComposition.missingCoins
    + reserveComposition.staleCoins
    + reserveComposition.degradedCoins
    + reserveComposition.errorCoins
    + reserveComposition.corruptCoins;
  const reserveCompositionCritical = !reserveCompositionBootstrap
    && reserveComposition.configuredCoins > 0
    && reserveComposition.freshCoins === 0
    && reserveIssueCount > 0;
  const reserveWarningFloor = Math.max(3, Math.ceil(reserveComposition.configuredCoins * 0.1));
  const reserveCompositionWarning = !reserveCompositionBootstrap && reserveIssueCount >= reserveWarningFloor;

  const baseAvailabilityStatus: StatusResponse["availabilityStatus"] =
    cacheStatusFloor === "stale" || anyCronError || unhealthyCrons >= 3
      ? "stale"
      : cacheStatusFloor === "degraded" || unhealthyCrons > 0
        ? "degraded"
        : "healthy";
  const availabilityStatus: StatusResponse["availabilityStatus"] = dbHealthy
    ? baseAvailabilityStatus
    : maxStatus(baseAvailabilityStatus, "degraded");

  const dataQualityStatus: StatusResponse["dataQualityStatus"] =
    dataQuality.stablecoinsCacheStatus === "error" ||
    missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioStale ||
    blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale ||
    blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentStale ||
    onchainAssessment.status === "stale" ||
    reserveCompositionCritical
      ? "stale"
      : dataQuality.stablecoinsCacheStatus === "degraded" ||
          dataQuality.sourceFailures.length > 0 ||
          missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded ||
          blacklistRecentMissing > 0 ||
          blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded ||
          onchainAssessment.status === "degraded" ||
          reserveCompositionWarning ||
          reserveCompositionQueryFailed
        ? "degraded"
        : "healthy";

  const rawOverallStatus = maxStatus(availabilityStatus, dataQualityStatus);

  const availabilityCauses: StatusCause[] = [];
  if (!dbHealthy) {
    pushCause(availabilityCauses, {
      code: "db_unhealthy",
      layer: "availability",
      severity: "warning",
      message: "Primary database connectivity check failed; data-quality queries were skipped.",
    });
  }
  if (worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale) {
    pushCause(availabilityCauses, {
      code: "cache_ratio_stale",
      layer: "availability",
      severity: "critical",
      message: `Cache freshness exceeded stale threshold (${worstCacheRatio.toFixed(2)}x > ${STATUS_CACHE_RATIO_THRESHOLDS.stale.toFixed(2)}x).`,
      metric: "worstCacheRatio",
      value: worstCacheRatio,
      threshold: STATUS_CACHE_RATIO_THRESHOLDS.stale,
    });
  } else if (worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.degraded) {
    pushCause(availabilityCauses, {
      code: "cache_ratio_degraded",
      layer: "availability",
      severity: "warning",
      message: `Cache freshness exceeded degraded threshold (${worstCacheRatio.toFixed(2)}x > ${STATUS_CACHE_RATIO_THRESHOLDS.degraded.toFixed(2)}x).`,
      metric: "worstCacheRatio",
      value: worstCacheRatio,
      threshold: STATUS_CACHE_RATIO_THRESHOLDS.degraded,
    });
  }
  if (cacheFailures.length > 0) {
    const cacheTargets = cacheFailures.map((failure) => failure.key).join(", ");
    pushCause(availabilityCauses, {
      code: "cache_freshness_query_failed",
      layer: "availability",
      severity: "warning",
      message: `Cache freshness diagnostics were incomplete for: ${cacheTargets}.`,
    });
  }
  const fxCache = caches["fx-rates"];
  if (fxCache?.mode === "cached-fallback") {
    pushCause(availabilityCauses, {
      code: "fx_cached_fallback",
      layer: "availability",
      severity: fxCache.consecutiveFallbackRuns != null && fxCache.consecutiveFallbackRuns >= 4 ? "warning" : "info",
      message:
        fxCache.warning ??
        `FX references are running in cached fallback mode (${fxCache.consecutiveFallbackRuns ?? 0} consecutive runs).`,
      metric: "fxFallbackRuns",
      value: fxCache.consecutiveFallbackRuns,
      threshold: 4,
    });
  }
  if (fxCache?.sourceStatus === "stale") {
    pushCause(availabilityCauses, {
      code: "fx_source_stale",
      layer: "availability",
      severity: "critical",
      message:
        fxCache.warning ??
        "Non-USD FX reference source data is stale relative to its expected source cadence even though usable FX rates still exist.",
      metric: "fxSourceAgeSeconds",
      value: fxCache.sourceAgeSeconds ?? undefined,
    });
  } else if (fxCache?.sourceStatus === "degraded") {
    pushCause(availabilityCauses, {
      code: "fx_source_degraded",
      layer: "availability",
      severity: "warning",
      message:
        fxCache.warning ??
        "Non-USD FX reference source data is behind its expected update cadence.",
      metric: "fxSourceAgeSeconds",
      value: fxCache.sourceAgeSeconds ?? undefined,
    });
  }
  if (cacheWarnings.length > 0) {
    for (const warning of cacheWarnings) {
      pushCause(availabilityCauses, {
        code: "cache_warning",
        layer: "availability",
        severity: "info",
        message: warning,
      });
    }
  }
  if (cronHistoryQueryFailed) {
    pushCause(availabilityCauses, {
      code: "cron_history_query_failed",
      layer: "availability",
      severity: "warning",
      message: "Cron history query failed; cron health is temporarily unknown rather than unhealthy.",
    });
  }
  if (cronProgressQueryFailed) {
    pushCause(availabilityCauses, {
      code: "cron_progress_query_failed",
      layer: "availability",
      severity: "info",
      message: "Cron progress query failed; in-flight cron telemetry is temporarily unavailable.",
    });
  }
  if (cronErrorCount > 0) {
    pushCause(availabilityCauses, {
      code: "cron_error_runs",
      layer: "availability",
      severity: "critical",
      message: `${cronErrorCount} cron job(s) currently have last-run status=error.`,
      metric: "cronErrors",
      value: cronErrorCount,
      threshold: 1,
    });
  }
  if (unhealthyCrons >= 3) {
    pushCause(availabilityCauses, {
      code: "multiple_unhealthy_crons",
      layer: "availability",
      severity: "critical",
      message: `${unhealthyCrons} cron jobs are unavailable/stale.`,
      metric: "unhealthyCrons",
      value: unhealthyCrons,
      threshold: 3,
    });
  } else if (unhealthyCrons > 0) {
    pushCause(availabilityCauses, {
      code: "unhealthy_crons_present",
      layer: "availability",
      severity: "warning",
      message: `${unhealthyCrons} cron job(s) are unavailable/stale.`,
      metric: "unhealthyCrons",
      value: unhealthyCrons,
      threshold: 1,
    });
  }
  if (degradedCronRuns > 0) {
    pushCause(availabilityCauses, {
      code: "degraded_cron_warning",
      layer: "availability",
      severity: "info",
      message: `${degradedCronRuns} cron job(s) are in fallback/degraded mode (warning-only).`,
      metric: "degradedCrons",
      value: degradedCronRuns,
      threshold: 1,
    });
  }

  const dataQualityCauses: StatusCause[] = [];
  if (dataQuality.stablecoinsCacheStatus === "error") {
    pushCause(dataQualityCauses, {
      code: "stablecoins_cache_unavailable",
      layer: "data-quality",
      severity: "critical",
      message: `Stablecoins cache is unavailable (${dataQuality.stablecoinsCacheReason ?? "unknown"}).`,
    });
  } else if (dataQuality.stablecoinsCacheStatus === "degraded") {
    pushCause(dataQualityCauses, {
      code: "stablecoins_cache_degraded",
      layer: "data-quality",
      severity: "warning",
      message: `Stablecoins cache is degraded (${dataQuality.stablecoinsCacheReason ?? "unknown"}).`,
    });
  }
  for (const failure of dataQuality.sourceFailures) {
    if (failure.source === "stablecoins-cache") continue;
    const code =
      failure.source === "blacklist-gaps"
        ? "blacklist_gap_query_failed"
        : failure.source === "active-depegs"
          ? "active_depeg_query_failed"
          : "onchain_supply_query_failed";
    pushCause(dataQualityCauses, {
      code,
      layer: "data-quality",
      severity: "warning",
      message: `${failure.source} query failed: ${failure.message}`,
    });
  }
  if (reserveCompositionQueryFailed) {
    pushCause(dataQualityCauses, {
      code: "reserve_sync_query_failed",
      layer: "data-quality",
      severity: "warning",
      message: "Live reserve composition overview query failed; reserve freshness status may be incomplete.",
    });
  }
  if (missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioStale) {
    pushCause(dataQualityCauses, {
      code: "missing_prices_stale",
      layer: "data-quality",
      severity: "critical",
      message: `Missing price ratio is stale (${formatRatio(missingPriceRatio)} > ${formatRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioStale)}).`,
      metric: "missingPriceRatio",
      value: missingPriceRatio,
      threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioStale,
    });
  } else if (missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded) {
    pushCause(dataQualityCauses, {
      code: "missing_prices_degraded",
      layer: "data-quality",
      severity: "warning",
      message: `Missing price ratio is degraded (${formatRatio(missingPriceRatio)} > ${formatRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded)}).`,
      metric: "missingPriceRatio",
      value: missingPriceRatio,
      threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded,
    });
  }
  if (
    blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale ||
    blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentStale
  ) {
    pushCause(dataQualityCauses, {
      code: "blacklist_gaps_stale",
      layer: "data-quality",
      severity: "critical",
      message: `Blacklist amount gaps exceed stale thresholds (ratio=${formatRatio(blacklistMissingRatio)}, recent=${blacklistRecentMissing}).`,
      metric: "blacklistMissingRatio",
      value: blacklistMissingRatio,
      threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioStale,
    });
  } else if (blacklistRecentMissing > 0 || blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded) {
    pushCause(dataQualityCauses, {
      code: "blacklist_gaps_degraded",
      layer: "data-quality",
      severity: "warning",
      message: `Recent or elevated blacklist amount gaps detected (ratio=${formatRatio(blacklistMissingRatio)}, recent=${blacklistRecentMissing}).`,
      metric: "blacklistMissingRatio",
      value: blacklistMissingRatio,
      threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded,
    });
  }
  for (const cause of onchainAssessment.causes) {
    pushCause(dataQualityCauses, cause);
  }
  if (reserveCompositionCritical) {
    pushCause(dataQualityCauses, {
      code: "reserve_sync_stale",
      layer: "data-quality",
      severity: "critical",
      message: "All configured live reserve feeds are missing, stale, or degraded.",
    });
  } else if (reserveCompositionWarning) {
    pushCause(dataQualityCauses, {
      code: "reserve_sync_degraded",
      layer: "data-quality",
      severity: "warning",
      message: `${reserveComposition.errorCoins} error, ${reserveComposition.missingCoins} missing, `
        + `${reserveComposition.staleCoins} stale, ${reserveComposition.degradedCoins} degraded, `
        + `${reserveComposition.corruptCoins} corrupt live reserve feed(s).`,
    });
  }

  const confidence = scoreConfidence({
    availabilityStatus,
    dataQualityStatus,
    unhealthyCrons,
    degradedCrons: degradedCronRuns,
    missingPriceRatio,
    onchainMonitoringActive: hasActiveOnchainMonitor,
  });

  return {
    dbHealthy,
    availabilityStatus,
    dataQualityStatus,
    rawOverallStatus,
    confidence,
    causes: {
      availability: availabilityCauses,
      dataQuality: dataQualityCauses,
      overall: synthesizeOverallCauses(availabilityCauses, dataQualityCauses),
    },
    caches,
    crons,
    dataQuality,
    telegramBot,
    sectionErrors,
    datasetFreshness,
    reserveComposition,
    summary: {
      unhealthyCrons,
      degradedCrons: degradedCronRuns,
      cronErrors: cronErrorCount,
      worstCacheRatio,
    },
  };
}
