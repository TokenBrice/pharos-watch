import { withErrorHandler, buildCacheStatuses, jsonResponse } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import { buildInClause } from "../lib/db";
import {
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
  reconcileStatusState,
  STATUS_SYSTEM_FRESHNESS_SEC,
  clampConfidence,
  type StatusLevel,
} from "../lib/status-reliability";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_CACHE_RATIO_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
  STATUS_ONCHAIN_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import {
  emptyDatasetFreshness,
  emptyReserveComposition,
  getDatasetFreshness,
  getMintBurnReconciliation,
  getTelegramBotStats,
} from "./status-derived-data";
import { emptyDataQuality, getDataQuality } from "./status-data-quality";
import { computeReserveCompositionOverview, loadFreshLiveReserveMap } from "../lib/live-reserves-store";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-cards";
import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type {
  CronInFlight,
  CronRun,
  CronStatus,
  DiscoveryCandidate,
  LiquidityHealth,
  MintBurnReconciliationSummary,
  PriceSourceHealth,
  ReserveDriftEntry,
  ClassificationWarning,
  StatusCause,
  StatusResponse,
} from "@shared/types";

// --- Config ---

const STATUS_SEVERITY: Record<StatusLevel, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

interface RawStatusComputation {
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

function fallbackState(rawOverallStatus: StatusLevel, now: number): StatusResponse["state"] {
  return {
    scope: "global",
    currentStatus: rawOverallStatus,
    rawStatus: rawOverallStatus,
    lastEvaluatedAt: now,
    lastChangedAt: now,
    minDwellSec: 120,
    staleMinDwellSec: 180,
    consecutiveRaw: {
      healthy: rawOverallStatus === "healthy" ? 1 : 0,
      degraded: rawOverallStatus === "degraded" ? 1 : 0,
      stale: rawOverallStatus === "stale" ? 1 : 0,
    },
    thresholds: {
      escalateToDegraded: 2,
      escalateToStale: 1,
      recoverToDegraded: 2,
      recoverToHealthy: 3,
    },
  };
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

async function computeRawStatus(db: D1Database, now: number): Promise<RawStatusComputation> {
  // 1. DB health sentinel gates the rest of the loader graph.
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

  // 2. Cache freshness
  const { caches, worstRatio: rawWorstCacheRatio, failures: cacheFailures } = await buildCacheStatuses(db, now);
  const worstCacheRatio = Number.isFinite(rawWorstCacheRatio) ? rawWorstCacheRatio : 99;

  // 3. Cron run history (batch query)
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

    cronProgressByJob = new Map(
      (progressRows.results ?? []).map((row) => {
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

  // Group by job, keeping only the 10 most recent per job
  const cronByJob = new Map<string, CronRun[]>();
  for (const r of cronRows.results ?? []) {
    const runs = cronByJob.get(r.job) ?? [];
    if (runs.length < 10) {
      const parsedMeta = parseMetadataObject(r.metadata);
      runs.push({
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        status: r.status,
        ...(r.error ? { error: r.error } : {}),
        ...(r.item_count != null ? { itemCount: r.item_count } : {}),
        ...(parsedMeta ? { metadata: parsedMeta } : {}),
      });
      cronByJob.set(r.job, runs);
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
    const inFlightFresh = inFlight != null && now - inFlight.updatedAt <= Math.max(300, interval);
    const isFresh = lastRun != null && now - lastRun.startedAt <= interval * 2;
    const hasFreshOk = runs.some((run) => run.status === "ok" && now - run.startedAt <= interval * 2);
    const availabilityHealthyFromLastRun =
      isFresh &&
      lastRun != null &&
      (lastRun.status === "ok" ||
        lastRun.status === "degraded" ||
        (lastRun.status === "skipped_locked" && hasFreshOk));
    const healthy = inFlightFresh || availabilityHealthyFromLastRun;
    const availabilityUnhealthy = !healthy;

    if (availabilityUnhealthy) unhealthyCrons++;
    if (lastRun?.status === "degraded" && isFresh) degradedCronRuns++;
    if (lastRun?.status === "error" && !inFlightFresh) {
      anyCronError = true;
      cronErrorCount++;
    }

    crons[job] = {
      lastRun,
      recentRuns: runs,
      expectedIntervalSec: interval,
      healthy,
      inFlight: (() => {
        if (!inFlight) return null;
        return {
          ...inFlight,
          stale: now - inFlight.updatedAt > Math.max(300, interval),
        };
      })(),
    };
  }

  // 4. Data quality + dataset freshness
  const dataQuality = dbHealthy ? await getDataQuality(db, now) : emptyDataQuality();
  const telegramBot = dbHealthy ? await getTelegramBotStats(db, now) : null;
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
  }
  const reserveCompositionBootstrap =
    reserveComposition.configuredCoins > 0
    && reserveComposition.lastSuccessAt == null;
  const missingPriceRatio =
    dataQuality.totalStablecoins > 0 ? dataQuality.missingPrices / dataQuality.totalStablecoins : 0;
  const blacklistMissingRatio = dataQuality.blacklistMissingRatio;
  const blacklistRecentMissing = dataQuality.blacklistRecentMissingAmounts;
  const hasActiveOnchainMonitor = dataQuality.onchainSupplyMonitoring === "active";
  const trackedOnchainCoins = hasActiveOnchainMonitor ? dataQuality.onchainSupplyTrackedCoins : 0;
  const staleOnchainSupply = hasActiveOnchainMonitor ? dataQuality.staleOnchainSupply : 0;
  const onchainSupplyDivergences = hasActiveOnchainMonitor ? dataQuality.onchainSupplyDivergences : 0;
  const staleOnchainRatio = trackedOnchainCoins > 0 ? staleOnchainSupply / trackedOnchainCoins : 0;
  const onchainDivergenceRatio = trackedOnchainCoins > 0 ? onchainSupplyDivergences / trackedOnchainCoins : 0;
  const reserveCompositionCritical =
    !reserveCompositionBootstrap
    && reserveComposition.configuredCoins > 0
    && reserveComposition.freshCoins === 0
    && (reserveComposition.missingCoins > 0 || reserveComposition.staleCoins > 0 || reserveComposition.degradedCoins > 0 || reserveComposition.errorCoins > 0);
  const reserveIssueCount =
    reserveComposition.missingCoins + reserveComposition.staleCoins + reserveComposition.degradedCoins + reserveComposition.errorCoins;
  const reserveWarningFloor = Math.max(3, Math.ceil(reserveComposition.configuredCoins * 0.1));
  const reserveCompositionWarning =
    !reserveCompositionBootstrap
    && reserveIssueCount >= reserveWarningFloor;

  // 5. Raw status synthesis
  const baseAvailabilityStatus: StatusResponse["availabilityStatus"] =
    worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale || anyCronError || unhealthyCrons >= 3
      ? "stale"
      : worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.degraded || unhealthyCrons > 0
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
    staleOnchainSupply >= STATUS_ONCHAIN_THRESHOLDS.staleAbsoluteStale ||
    onchainSupplyDivergences >= STATUS_ONCHAIN_THRESHOLDS.divergenceAbsoluteStale ||
    staleOnchainRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale ||
    onchainDivergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale ||
    reserveCompositionCritical
      ? "stale"
      : dataQuality.stablecoinsCacheStatus === "degraded" ||
          dataQuality.sourceFailures.length > 0 ||
          missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded ||
          blacklistRecentMissing > 0 ||
          blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded ||
          staleOnchainRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded ||
          onchainDivergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded ||
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
  if (cronHistoryQueryFailed) {
    pushCause(availabilityCauses, {
      code: "cron_history_query_failed",
      layer: "availability",
      severity: "warning",
      message: "Cron history query failed; cron health is being inferred from fallback defaults.",
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
  if (hasActiveOnchainMonitor) {
    if (
      staleOnchainRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale ||
      onchainDivergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale
    ) {
      pushCause(dataQualityCauses, {
        code: "onchain_integrity_stale",
        layer: "data-quality",
        severity: "critical",
        message: `On-chain integrity stale (stale=${formatRatio(staleOnchainRatio)}, divergence=${formatRatio(onchainDivergenceRatio)}).`,
        metric: "onchainStaleRatio",
        value: staleOnchainRatio,
        threshold: STATUS_ONCHAIN_THRESHOLDS.ratioStale,
      });
    } else if (
      staleOnchainRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded ||
      onchainDivergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded
    ) {
      pushCause(dataQualityCauses, {
        code: "onchain_integrity_degraded",
        layer: "data-quality",
        severity: "warning",
        message: `On-chain integrity degraded (stale=${formatRatio(staleOnchainRatio)}, divergence=${formatRatio(onchainDivergenceRatio)}).`,
        metric: "onchainStaleRatio",
        value: staleOnchainRatio,
        threshold: STATUS_ONCHAIN_THRESHOLDS.ratioDegraded,
      });
    }
  }
  if (!hasActiveOnchainMonitor && dataQuality.onchainSupplyMonitoring === "unavailable") {
    pushCause(dataQualityCauses, {
      code: "onchain_monitor_unavailable",
      layer: "data-quality",
      severity: "info",
      message: "On-chain supply monitor has no active producer. On-chain integrity checks are skipped.",
    });
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
      message: `${reserveComposition.errorCoins} error, ${reserveComposition.missingCoins} missing, ${reserveComposition.staleCoins} stale, ${reserveComposition.degradedCoins} degraded live reserve feed(s).`,
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

// --- Handler ---

export const handleStatus = withErrorHandler(
  "status",
  async (db: D1Database, trustedAdmin?: boolean, request?: Request): Promise<Response> => {
    return withAdmin(request, async () => {
      const now = Math.floor(Date.now() / 1000);
      const raw = await computeRawStatus(db, now);

      let { state, staleness } = await getStatusStateSnapshot(db, now);

      // Bootstrap or refresh stale state on-demand in case the self-check cron is delayed.
      if (!state || staleness?.isStale) {
        const seeded = await reconcileStatusState(db, now, raw.rawOverallStatus, raw.confidence, raw.causes.overall);
        state = seeded.state;
        staleness = {
          ageSeconds: 0,
          maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
          isStale: false,
        };
      }

      const effectiveOverallStatus = state?.currentStatus ?? raw.rawOverallStatus;
      const probe = await getLatestStatusProbe(db);
      const discrepancyStreak = await getDiscrepancyStreak(db);
      const discrepancy = buildDiscrepancy(effectiveOverallStatus, probe, now, discrepancyStreak);
      const timeline = await listRecentStatusTransitions(db, 40);

      // Discovery candidates (active only, top 20 by market cap)
      let discoveryCandidates: DiscoveryCandidate[] | null = null;
      try {
        const discRows = await db.prepare(
          "SELECT id, gecko_id, llama_id, name, symbol, market_cap, source, first_seen, last_seen, dismissed FROM discovery_candidates WHERE dismissed = 0 ORDER BY market_cap DESC LIMIT 20",
        ).all();
        discoveryCandidates = (discRows.results ?? []).map((row: Record<string, unknown>) => ({
          id: row.id as number,
          geckoId: row.gecko_id as string | null,
          llamaId: row.llama_id as number | null,
          name: row.name as string,
          symbol: row.symbol as string,
          marketCap: row.market_cap as number | null,
          source: row.source as "defillama" | "coingecko" | "both",
          firstSeen: row.first_seen as number,
          lastSeen: row.last_seen as number,
          daysSeen: Math.max(1, Math.floor((now - (row.first_seen as number)) / 86400)),
          dismissed: false,
        }));
      } catch (err) {
        console.warn("[status] Discovery candidates query failed:", err);
      }

      // Liquidity health from already-loaded dex-liquidity cron metadata.
      let liquidityHealth: LiquidityHealth | null = null;
      try {
        const dexLiquidityCron = raw.crons?.["sync-dex-liquidity"];
        const metadata = dexLiquidityCron?.lastRun?.metadata;
        const sourceCoverage = metadata?.sourceCoverage as Record<string, unknown> | undefined;
        if (dexLiquidityCron?.lastRun && sourceCoverage) {
          liquidityHealth = {
            lastRunStatus: dexLiquidityCron.lastRun.status,
            currentCoverage: Number(sourceCoverage.currentCoverage ?? 0),
            previousCoverage: sourceCoverage.previousCoverage != null ? Number(sourceCoverage.previousCoverage) : null,
            currentGlobalTvl: sourceCoverage.currentGlobalTvl != null ? Number(sourceCoverage.currentGlobalTvl) : null,
            previousGlobalTvl: sourceCoverage.previousGlobalTvl != null ? Number(sourceCoverage.previousGlobalTvl) : null,
            currentTop10CoveredTvl: sourceCoverage.currentTop10CoveredTvl != null ? Number(sourceCoverage.currentTop10CoveredTvl) : null,
            previousTop10CoveredTvl: sourceCoverage.previousTop10CoveredTvl != null ? Number(sourceCoverage.previousTop10CoveredTvl) : null,
            failedSources: Array.isArray(metadata?.failedSources) ? metadata.failedSources.filter((v): v is string => typeof v === "string") : [],
            nearCoverageGuard: Boolean(sourceCoverage.nearCoverageGuard),
            nearValueGuard: Boolean(sourceCoverage.nearValueGuard),
            nearMajorCoverageGuard: Boolean(sourceCoverage.nearMajorCoverageGuard),
            currentCoverageClasses: {
              primary: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.primary ?? 0),
              mixed: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.mixed ?? 0),
              fallback: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.fallback ?? 0),
              legacy: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.legacy ?? 0),
              unobserved: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.unobserved ?? 0),
            },
            previousCoverageClasses: {
              primary: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.primary ?? 0),
              mixed: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.mixed ?? 0),
              fallback: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.fallback ?? 0),
              legacy: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.legacy ?? 0),
              unobserved: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.unobserved ?? 0),
            },
          };
        }
      } catch (err) {
        console.warn("[status] Liquidity health extraction failed:", err);
      }

      // Price source health from already-loaded cron metadata (no extra DB query)
      let priceSourceHealth: PriceSourceHealth | null = null;
      try {
        const syncStablecoinsCron = raw.crons?.["sync-stablecoins"];
        if (syncStablecoinsCron?.lastRun?.metadata) {
          const meta = syncStablecoinsCron.lastRun.metadata;
          if (meta.priceSourceHealth) {
            priceSourceHealth = meta.priceSourceHealth as PriceSourceHealth;
          }
        }
      } catch (err) {
        console.warn("[status] Price source health extraction failed:", err);
      }

      let mintBurnReconciliation: MintBurnReconciliationSummary | null = null;
      try {
        mintBurnReconciliation = await getMintBurnReconciliation(db, now);
      } catch (err) {
        console.warn("[status] Mint/burn reconciliation query failed:", err);
      }

      // Reserve drift (threshold: 5 points — lower than the 15pt console.warn threshold)
      let reserveDrift: ReserveDriftEntry[] | undefined;
      try {
        const liveReserveMap = await loadFreshLiveReserveMap(db, now);
        const driftEntries: ReserveDriftEntry[] = [];
        for (const [coinId, liveSlices] of liveReserveMap) {
          const meta = TRACKED_STABLECOINS.find((c) => c.id === coinId);
          if (!meta?.reserves?.length) continue;
          const liveScore = computeCollateralQualityFromReserves(liveSlices);
          const curatedScore = computeCollateralQualityFromReserves(meta.reserves);
          const delta = Math.abs(liveScore - curatedScore);
          if (delta > 5) {
            driftEntries.push({ coinId, liveCollateralScore: liveScore, curatedCollateralScore: curatedScore, delta });
          }
        }
        driftEntries.sort((a, b) => b.delta - a.delta);
        if (driftEntries.length > 0) reserveDrift = driftEntries;
      } catch (err) {
        console.warn("[status] Reserve drift computation failed:", err);
      }

      // Classification warnings
      let classificationWarnings: ClassificationWarning[] | undefined;
      try {
        const threshold = 0.50;
        const warnings: ClassificationWarning[] = [];
        const defiCoins = TRACKED_STABLECOINS.filter((c) => c.flags.governance === "decentralized");
        for (const coin of defiCoins) {
          const fraction = computeCentralizedCustodyFraction(coin.id, TRACKED_STABLECOINS);
          if (fraction > threshold) {
            warnings.push({
              coinId: coin.id,
              governance: coin.flags.governance,
              centralizedCustodyPct: Math.round(fraction * 100),
              threshold: threshold * 100,
            });
          }
        }
        if (warnings.length > 0) classificationWarnings = warnings;
      } catch (err) {
        console.warn("[status] Classification warnings computation failed:", err);
      }

      const body: StatusResponse = {
        timestamp: now,
        dbHealthy: raw.dbHealthy,
        availabilityStatus: raw.availabilityStatus,
        dataQualityStatus: raw.dataQualityStatus,
        rawOverallStatus: raw.rawOverallStatus,
        overallStatus: effectiveOverallStatus,
        confidence: raw.confidence,
        causes: raw.causes,
        state: state ?? fallbackState(raw.rawOverallStatus, now),
        staleness: staleness ?? {
          ageSeconds: 0,
          maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
          isStale: false,
        },
        probe,
        discrepancy,
        timeline,
        caches: raw.caches,
        crons: raw.crons,
        dataQuality: raw.dataQuality,
        telegramBot: raw.telegramBot,
        datasetFreshness: raw.datasetFreshness,
        summary: raw.summary,
        reserveComposition: raw.reserveComposition,
        liquidityHealth,
        priceSourceHealth,
        discoveryCandidates,
        mintBurnReconciliation,
        reserveDrift,
        classificationWarnings,
      };

      return jsonResponse(body, { "Cache-Control": "no-store" });
    }, trustedAdmin);
  },
);
