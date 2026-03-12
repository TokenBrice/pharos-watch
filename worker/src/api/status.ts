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
import { queryBlacklistGapMetrics } from "../lib/blacklist-gaps";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import { CRON_INTERVALS } from "../lib/cron-schedule";
import {
  BLACKLIST_RECENT_WINDOW_SEC,
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_ONCHAIN_THRESHOLDS,
} from "../lib/status-thresholds";
import {
  emptyDatasetFreshness,
  emptyReserveComposition,
  getDatasetFreshness,
  getMintBurnReconciliation,
  getTelegramBotStats,
} from "./status-derived-data";
import { computeReserveCompositionOverview } from "../lib/live-reserves-store";
import type {
  CronInFlight,
  CronRun,
  CronStatus,
  DataQuality,
  DiscoveryCandidate,
  LiquidityHealth,
  MintBurnReconciliationSummary,
  PriceSourceHealth,
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

type DataQualitySourceKey = StatusResponse["dataQuality"]["sourceFailures"][number]["source"];

function recordDataQualityFailure(
  bucket: StatusResponse["dataQuality"]["sourceFailures"],
  source: DataQualitySourceKey,
  err: unknown,
): void {
  if (bucket.some((entry) => entry.source === source)) {
    return;
  }
  bucket.push({
    source,
    message: err instanceof Error ? err.message : String(err),
  });
}

function emptyDataQuality(): DataQuality {
  return {
    stablecoinsCacheStatus: "error",
    stablecoinsCacheReason: "db-unavailable",
    blacklistGapStatus: "failed",
    activeDepegStatus: "failed",
    onchainSupplyQueryStatus: "failed",
    sourceFailures: [],
    totalStablecoins: 0,
    missingPrices: 0,
    blacklistMissingAmounts: 0,
    blacklistRecentMissingAmounts: 0,
    blacklistRecentWindowSec: BLACKLIST_RECENT_WINDOW_SEC,
    blacklistMissingRatio: 0,
    blacklistTotal: 0,
    onchainSupplyDivergences: 0,
    onchainDivergenceRatio: 0,
    onchainSupplyMonitoring: "unavailable",
    onchainSupplyLatestAt: null,
    onchainSupplyTrackedCoins: 0,
    activeDepegs: 0,
    staleOnchainSupply: 0,
    onchainStaleRatio: 0,
  };
}

async function getDataQuality(db: D1Database, now: number): Promise<DataQuality> {
  const stablecoinsCacheResult = await loadStablecoinsCache(db, {
    mode: "lenient",
    allowLegacyArray: true,
  });
  const sourceFailures: StatusResponse["dataQuality"]["sourceFailures"] = [];
  if (stablecoinsCacheResult.kind !== "ok") {
    console.warn(`[status] stablecoins cache ${stablecoinsCacheResult.kind} (${stablecoinsCacheResult.reason})`);
    recordDataQualityFailure(sourceFailures, "stablecoins-cache", stablecoinsCacheResult.reason);
  }
  const stablecoinAssets = hasUsableStablecoinsPayload(stablecoinsCacheResult)
    ? stablecoinsCacheResult.payload.peggedAssets as Array<{
        id: string;
        price?: number;
        circulating?: Record<string, number>;
      }>
    : [];
  const stablecoinAssetMap = new Map(stablecoinAssets.map((asset) => [asset.id, asset]));

  const totalStablecoins = stablecoinAssets.length;
  const missingPrices = stablecoinAssets.filter(
    (asset: { price?: number | null }) => asset.price == null || asset.price === 0,
  ).length;

  let blacklistTotal = 0;
  let blacklistMissingAmounts = 0;
  let blacklistRecentMissingAmounts = 0;
  let blacklistGapStatus: DataQuality["blacklistGapStatus"] = "ok";
  try {
    const gaps = await queryBlacklistGapMetrics(db, now, BLACKLIST_RECENT_WINDOW_SEC);
    blacklistTotal = gaps.totalEvents;
    blacklistMissingAmounts = gaps.missingAmounts;
    blacklistRecentMissingAmounts = gaps.recentMissingAmounts;
  } catch (e) {
    blacklistGapStatus = "failed";
    recordDataQualityFailure(sourceFailures, "blacklist-gaps", e);
    console.error("[status] Failed to query blacklist gaps:", e);
  }

  let activeDepegs = 0;
  let activeDepegStatus: DataQuality["activeDepegStatus"] = "ok";
  try {
    const dp = await db
      .prepare("SELECT COUNT(*) as cnt FROM depeg_events WHERE ended_at IS NULL")
      .first<{ cnt: number }>();
    if (dp) activeDepegs = dp.cnt;
  } catch (e) {
    activeDepegStatus = "failed";
    recordDataQualityFailure(sourceFailures, "active-depegs", e);
    console.error("[status] Failed to query active depegs:", e);
  }

  let staleOnchainSupply = 0;
  let onchainSupplyDivergences = 0;
  let onchainSupplyMonitoring: DataQuality["onchainSupplyMonitoring"] = "unavailable";
  let onchainSupplyQueryStatus: DataQuality["onchainSupplyQueryStatus"] = "unavailable";
  let onchainSupplyLatestAt: number | null = null;
  let onchainSupplyTrackedCoins = 0;
  try {
    const monitor = await db
      .prepare("SELECT MAX(updated_at) as latest, COUNT(DISTINCT stablecoin_id) as tracked FROM onchain_supply")
      .first<{ latest: number | null; tracked: number }>();
    onchainSupplyLatestAt = monitor?.latest ?? null;
    onchainSupplyTrackedCoins = monitor?.tracked ?? 0;

    if (onchainSupplyLatestAt != null && now - onchainSupplyLatestAt <= 3 * 86400) {
      onchainSupplyMonitoring = "active";
      onchainSupplyQueryStatus = "ok";
    }
  } catch (e) {
    onchainSupplyQueryStatus = "failed";
    recordDataQualityFailure(sourceFailures, "onchain-supply", e);
    console.error("[status] Failed to query stale on-chain supply:", e);
  }

  if (onchainSupplyMonitoring === "active") {
    try {
      const stale = await db
        .prepare(
          `SELECT COUNT(*) as cnt
           FROM (
             SELECT stablecoin_id, MAX(updated_at) as latest_update
             FROM onchain_supply
             GROUP BY stablecoin_id
             HAVING latest_update < ?
           )`,
        )
        .bind(now - 7200)
        .first<{ cnt: number }>();
      if (stale) staleOnchainSupply = stale.cnt;
    } catch (e) {
      onchainSupplyQueryStatus = "failed";
      recordDataQualityFailure(sourceFailures, "onchain-supply", e);
      console.error("[status] Failed to query stale on-chain supply:", e);
    }

    try {
      const onchainRows = await db
        .prepare(
          "SELECT stablecoin_id, SUM(supply) as total_supply FROM onchain_supply WHERE updated_at > ? GROUP BY stablecoin_id",
        )
        .bind(now - 7200)
        .all<{ stablecoin_id: string; total_supply: number }>();

      if (onchainRows.results && onchainRows.results.length > 0) {
        for (const row of onchainRows.results) {
          const asset = stablecoinAssetMap.get(row.stablecoin_id);
          if (!asset?.price || asset.price <= 0 || !asset.circulating) continue;
          const llamaValues = Object.values(asset.circulating);
          const llamaTotal = llamaValues.reduce((sum, value) => sum + (value ?? 0), 0);
          const llamaSupply = llamaTotal / asset.price;
          if (llamaSupply > 0) {
            const divergence = Math.abs(row.total_supply - llamaSupply) / llamaSupply;
            if (divergence > 0.05) onchainSupplyDivergences++;
          }
        }
      }
    } catch (e) {
      onchainSupplyQueryStatus = "failed";
      recordDataQualityFailure(sourceFailures, "onchain-supply", e);
      console.error("[status] Failed to check on-chain supply divergences:", e);
    }
  }

  return {
    stablecoinsCacheStatus: stablecoinsCacheResult.kind,
    stablecoinsCacheReason: stablecoinsCacheResult.kind === "ok" ? null : stablecoinsCacheResult.reason,
    blacklistGapStatus,
    activeDepegStatus,
    onchainSupplyQueryStatus,
    sourceFailures,
    totalStablecoins,
    missingPrices,
    blacklistMissingAmounts,
    blacklistRecentMissingAmounts,
    blacklistRecentWindowSec: BLACKLIST_RECENT_WINDOW_SEC,
    blacklistMissingRatio: blacklistTotal > 0 ? blacklistMissingAmounts / blacklistTotal : 0,
    blacklistTotal,
    onchainSupplyDivergences,
    onchainDivergenceRatio:
      onchainSupplyMonitoring === "active" && onchainSupplyTrackedCoins > 0
        ? onchainSupplyDivergences / onchainSupplyTrackedCoins
        : 0,
    onchainSupplyMonitoring,
    onchainSupplyLatestAt,
    onchainSupplyTrackedCoins,
    activeDepegs,
    staleOnchainSupply,
    onchainStaleRatio:
      onchainSupplyMonitoring === "active" && onchainSupplyTrackedCoins > 0
        ? staleOnchainSupply / onchainSupplyTrackedCoins
        : 0,
  };
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
  // 1. Cache freshness
  const { caches, worstRatio: worstCacheRatio } = await buildCacheStatuses(db, now);

  // 2. Cron run history (batch query)
  const cronJobs = Object.keys(CRON_INTERVALS);
  const cronJobInClause = buildInClause(cronJobs);
  const cronRows = await db
    .prepare(
      `SELECT job, started_at, duration_ms, status, error, item_count, metadata
       FROM cron_runs
       WHERE job IN (${cronJobInClause.sql})
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

  let cronProgressByJob = new Map<string, CronInFlight>();
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
        let parsedMeta: Record<string, unknown> | undefined;
        if (row.metadata) {
          try {
            parsedMeta = JSON.parse(row.metadata);
          } catch {
            parsedMeta = undefined;
          }
        }

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
    console.warn("[status] cron_run_progress unavailable:", err);
  }

  // Group by job, keeping only the 10 most recent per job
  const cronByJob = new Map<string, CronRun[]>();
  for (const r of cronRows.results ?? []) {
    const runs = cronByJob.get(r.job) ?? [];
    if (runs.length < 10) {
      let parsedMeta: Record<string, unknown> | undefined;
      if (r.metadata) {
        try {
          parsedMeta = JSON.parse(r.metadata);
        } catch {
          // Ignore malformed metadata.
        }
      }
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

  // 3. DB health sentinel (short-circuits data quality + dataset freshness when unavailable).
  let dbHealthy = true;
  try {
    await db.prepare("SELECT 1").first();
  } catch (err) {
    dbHealthy = false;
    console.error("[status] DB health sentinel failed:", err);
  }

  // 4. Data quality + dataset freshness
  const dataQuality = dbHealthy ? await getDataQuality(db, now) : emptyDataQuality();
  const telegramBot = dbHealthy ? await getTelegramBotStats(db, now) : null;
  const datasetFreshness = dbHealthy ? await getDatasetFreshness(db) : emptyDatasetFreshness();
  const reserveComposition = dbHealthy
    ? await computeReserveCompositionOverview(db, now)
    : emptyReserveComposition();
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
    && (reserveComposition.missingCoins > 0 || reserveComposition.staleCoins > 0 || reserveComposition.degradedCoins > 0);
  const reserveCompositionWarning =
    !reserveCompositionBootstrap
    && (reserveComposition.missingCoins > 0 || reserveComposition.staleCoins > 0 || reserveComposition.degradedCoins > 0);

  // 5. Raw status synthesis
  const baseAvailabilityStatus: StatusResponse["availabilityStatus"] =
    worstCacheRatio > 2 || anyCronError || unhealthyCrons >= 3
      ? "stale"
      : worstCacheRatio > 1.5 || unhealthyCrons > 0
        ? "degraded"
        : "healthy";
  const availabilityStatus: StatusResponse["availabilityStatus"] = dbHealthy
    ? baseAvailabilityStatus
    : maxStatus(baseAvailabilityStatus, "degraded");

  const dataQualityStatus: StatusResponse["dataQualityStatus"] =
    dataQuality.stablecoinsCacheStatus === "error" ||
    missingPriceRatio > 0.4 ||
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
          missingPriceRatio > 0.15 ||
          blacklistRecentMissing > 0 ||
          blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded ||
          staleOnchainRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded ||
          onchainDivergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded ||
          reserveCompositionWarning
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
  if (worstCacheRatio > 2) {
    pushCause(availabilityCauses, {
      code: "cache_ratio_stale",
      layer: "availability",
      severity: "critical",
      message: `Cache freshness exceeded stale threshold (${worstCacheRatio.toFixed(2)}x > 2.00x).`,
      metric: "worstCacheRatio",
      value: worstCacheRatio,
      threshold: 2,
    });
  } else if (worstCacheRatio > 1.5) {
    pushCause(availabilityCauses, {
      code: "cache_ratio_degraded",
      layer: "availability",
      severity: "warning",
      message: `Cache freshness exceeded degraded threshold (${worstCacheRatio.toFixed(2)}x > 1.50x).`,
      metric: "worstCacheRatio",
      value: worstCacheRatio,
      threshold: 1.5,
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
  if (missingPriceRatio > 0.4) {
    pushCause(dataQualityCauses, {
      code: "missing_prices_stale",
      layer: "data-quality",
      severity: "critical",
      message: `Missing price ratio is stale (${formatRatio(missingPriceRatio)} > 40%).`,
      metric: "missingPriceRatio",
      value: missingPriceRatio,
      threshold: 0.4,
    });
  } else if (missingPriceRatio > 0.15) {
    pushCause(dataQualityCauses, {
      code: "missing_prices_degraded",
      layer: "data-quality",
      severity: "warning",
      message: `Missing price ratio is degraded (${formatRatio(missingPriceRatio)} > 15%).`,
      metric: "missingPriceRatio",
      value: missingPriceRatio,
      threshold: 0.15,
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
      message: `${reserveComposition.missingCoins} missing, ${reserveComposition.staleCoins} stale, ${reserveComposition.degradedCoins} degraded live reserve feed(s).`,
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
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    return withAdmin(request, adminKey, async () => {
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
          "SELECT * FROM discovery_candidates WHERE dismissed = 0 ORDER BY market_cap DESC LIMIT 20",
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
      };

      return jsonResponse(body, { "Cache-Control": "no-store" });
    });
  },
);
