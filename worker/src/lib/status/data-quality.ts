import {
  BLACKLIST_GAP_METRICS_DIAGNOSTIC_CACHE_TTL_SEC,
  BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC,
  queryBlacklistGapMetrics,
} from "../blacklist-gaps";
import type { BlacklistGapMetrics } from "../blacklist-gaps";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../stablecoins-cache";
import {
  BLACKLIST_RECENT_WINDOW_SEC,
  STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD,
  STATUS_ONCHAIN_FRESH_WINDOW_SEC,
  STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC,
} from "@shared/lib/status-thresholds";
import { getCirculatingRaw } from "@shared/lib/supply";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import type { DataQuality, StatusResponse } from "@shared/types/status";
import { logWorkerEvent } from "../structured-log";
import { getSourceFailureMessage } from "./section-errors";
import { loadDdrRepairDebtDetails, loadRepairDebtSummary } from "../repair-tasks";
import {
  EMPTY_BLACKLIST_RECONCILIATION_STATUS,
  loadBlacklistReconciliationStatus,
} from "../blacklist-reconciliation-status";
import {
  loadStablecoinPublicationHealth,
  unknownStablecoinPublicationHealth,
} from "../stablecoin-publication-health";

function emptyRepairDebt(source: DataQuality["repairDebt"]["source"] = "unavailable"): DataQuality["repairDebt"] {
  return {
    status: "unknown",
    openCount: 0,
    oldestAgeSec: null,
    byKind: {},
    availabilityEscalated: false,
    nextRunnerDueAt: null,
    source,
  };
}

type DataQualitySourceKey = StatusResponse["dataQuality"]["sourceFailures"][number]["source"];

function recordDataQualityFailure(
  bucket: StatusResponse["dataQuality"]["sourceFailures"],
  source: DataQualitySourceKey,
  _err: unknown,
): void {
  if (bucket.some((entry) => entry.source === source)) {
    return;
  }
  bucket.push({
    source,
    message: getSourceFailureMessage(source),
  });
}

export function emptyDataQuality(): DataQuality {
  return {
    stablecoinsCacheStatus: "error",
    stablecoinsCacheReason: "db-unavailable",
    blacklistGapStatus: "failed",
    activeDepegStatus: "failed",
    onchainSupplyQueryStatus: "failed",
    repairDebt: emptyRepairDebt(),
    ddrRepairDebtStatus: "unknown",
    ddrRepairDebtCount: 0,
    ddrRepairDebtCheckedAt: null,
    ddrRepairDebtEvents: [],
    ddrRepairDebtEventsTruncated: false,
    sourceFailures: [],
    totalStablecoins: 0,
    missingPrices: 0,
    stablecoinPublication: unknownStablecoinPublicationHealth(),
    blacklistMissingAmounts: 0,
    blacklistRecentMissingAmounts: 0,
    blacklistRecentWindowSec: BLACKLIST_RECENT_WINDOW_SEC,
    blacklistMissingRatio: 0,
    blacklistTotal: 0,
    blacklistOldestRecoverableAgeSec: null,
    blacklistNeverAttemptedCount: 0,
    blacklistRepeatedFailureCount: 0,
    blacklistReconciliation: {
      ...EMPTY_BLACKLIST_RECONCILIATION_STATUS,
      status: "unknown",
    },
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

export async function getDataQuality(
  db: D1Database,
  now: number,
  options?: {
    blacklistMetrics?: BlacklistGapMetrics | null;
  },
): Promise<DataQuality> {
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient" });
  const sourceFailures: StatusResponse["dataQuality"]["sourceFailures"] = [];
  if (stablecoinsCacheResult.kind !== "ok") {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "stablecoins_cache_unavailable",
      route: "status",
      source: "stablecoins-cache",
      message: "Stablecoins cache unavailable",
      metadata: {
        kind: stablecoinsCacheResult.kind,
        reason: stablecoinsCacheResult.reason,
      },
    });
    recordDataQualityFailure(sourceFailures, "stablecoins-cache", stablecoinsCacheResult.reason);
  }
  const stablecoinAssets = hasUsableStablecoinsPayload(stablecoinsCacheResult)
    ? (stablecoinsCacheResult.payload.peggedAssets as Array<{
        id: string;
        price?: number;
        circulating?: Record<string, number>;
      }>)
    : [];
  const stablecoinAssetMap = new Map(stablecoinAssets.map((asset) => [asset.id, asset]));

  // Scope `missingPriceRatio` denominator to active canonical stablecoins
  // only. The DL stablecoins API emits residuals (numeric IDs not in
  // canonical-order.json) that ride in the cache but are not actively
  // tracked, and pre-launch canonical coins legitimately have no price yet.
  // Counting either inflates the ratio and drives false degradations.
  // DefiLlama residuals and pre-launch canonical coins should not drive the
  // active canonical missing-price ratio.
  const activeCanonicalAssets = stablecoinAssets.filter((asset) => ACTIVE_IDS.has(asset.id));
  let stablecoinPublication = unknownStablecoinPublicationHealth();
  try {
    stablecoinPublication = await loadStablecoinPublicationHealth(db);
  } catch (error) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "stablecoin_publication_health_query_failed",
      route: "status",
      source: "sync-stablecoins",
      message: "Stablecoin publication coverage metadata unavailable",
      error,
    });
  }
  const hasExactPublicationEvidence = stablecoinPublication.status !== "unknown";
  const totalStablecoins = hasExactPublicationEvidence
    ? stablecoinPublication.expectedActiveCount
    : activeCanonicalAssets.length;
  const missingPrices = activeCanonicalAssets.filter(
    (asset: { price?: number | null }) => asset.price == null || asset.price === 0,
  ).length + (stablecoinPublication.status === "incomplete" ? stablecoinPublication.missingActiveIds.length : 0);

  let blacklistTotal = 0;
  let blacklistMissingAmounts = 0;
  let blacklistRecentMissingAmounts = 0;
  let blacklistOldestRecoverableAgeSec: number | null = null;
  let blacklistNeverAttemptedCount = 0;
  let blacklistRepeatedFailureCount = 0;
  let blacklistGapStatus: DataQuality["blacklistGapStatus"] = "ok";
  let blacklistReconciliation: NonNullable<DataQuality["blacklistReconciliation"]> = {
    ...EMPTY_BLACKLIST_RECONCILIATION_STATUS,
    status: "unknown",
  };
  try {
    const gaps =
      options?.blacklistMetrics ??
      (await queryBlacklistGapMetrics(db, now, {
        recentWindowSec: BLACKLIST_RECENT_WINDOW_SEC,
        includeDistributions: false,
        producerSnapshotTtlSec: BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC,
        cacheTtlSec: BLACKLIST_GAP_METRICS_DIAGNOSTIC_CACHE_TTL_SEC,
      }));
    blacklistTotal = gaps.totalEvents;
    blacklistMissingAmounts = gaps.missingAmounts;
    blacklistRecentMissingAmounts = gaps.recentMissingAmounts;
    blacklistOldestRecoverableAgeSec = gaps.oldestRecoverableAgeSec;
    blacklistNeverAttemptedCount = gaps.neverAttemptedCount;
    blacklistRepeatedFailureCount = gaps.repeatedFailureCount;
  } catch (e) {
    blacklistGapStatus = "failed";
    recordDataQualityFailure(sourceFailures, "blacklist-gaps", e);
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "blacklist_gaps_query_failed",
      route: "status",
      source: "blacklist-gaps",
      message: "Failed to query blacklist gaps",
      error: e,
    });
  }

  try {
    blacklistReconciliation = await loadBlacklistReconciliationStatus(db);
  } catch (error) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "blacklist_reconciliation_status_query_failed",
      route: "status",
      source: "blacklist-reconciliation",
      message: "Failed to query blacklist reconciliation status",
      error,
    });
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
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "active_depegs_query_failed",
      route: "status",
      source: "depeg_events",
      message: "Failed to query active depegs",
      error: e,
    });
  }

  let ddrRepairDebtStatus: DataQuality["ddrRepairDebtStatus"] = "ok";
  let ddrRepairDebtCount = 0;
  let ddrRepairDebtCheckedAt: number | null = null;
  let ddrRepairDebtEvents: DataQuality["ddrRepairDebtEvents"] = [];
  let ddrRepairDebtEventsTruncated = false;
  let repairDebt: DataQuality["repairDebt"] = emptyRepairDebt();
  try {
    repairDebt = await loadRepairDebtSummary(db, now);
  } catch (e) {
    ddrRepairDebtStatus = "unknown";
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "repair_debt_task_summary_query_failed",
      route: "status",
      source: "worker-repair-tasks",
      message: "Failed to query repair task summary; DDR repair debt status is unknown",
      error: e,
    });
  }
  const ddrTaskCount = repairDebt.byKind["ddr-repair-required-event"]?.openCount ?? 0;
  if (ddrRepairDebtStatus !== "unknown" && ddrTaskCount > 0) {
    try {
      const ddrRepairDebt = await loadDdrRepairDebtDetails(db);
      ddrRepairDebtStatus = "present";
      ddrRepairDebtCount = ddrTaskCount;
      ddrRepairDebtCheckedAt = ddrRepairDebt.checkedAt;
      ddrRepairDebtEvents = ddrRepairDebt.events;
      ddrRepairDebtEventsTruncated = ddrRepairDebt.eventsTruncated || ddrTaskCount > ddrRepairDebt.events.length;
    } catch (e) {
      ddrRepairDebtStatus = "unknown";
      logWorkerEvent({
        scope: "status",
        level: "warn",
        event: "ddr_repair_debt_detail_query_failed",
        route: "status",
        source: "worker-repair-tasks",
        message: "Failed to query DDR repair debt task details",
        error: e,
      });
    }
  }

  let staleOnchainSupply = 0;
  let onchainSupplyDivergences = 0;
  let onchainSupplyMonitoring: DataQuality["onchainSupplyMonitoring"] = "unavailable";
  let onchainSupplyQueryStatus: DataQuality["onchainSupplyQueryStatus"] = "unavailable";
  let onchainSupplyLatestAt: number | null = null;
  let onchainSupplyTrackedCoins = 0;
  const onchainActiveWindowStart = now - STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC;
  try {
    const monitor = await db
      .prepare(
        "SELECT MAX(updated_at) as latest, COUNT(DISTINCT CASE WHEN updated_at >= ? THEN stablecoin_id END) as tracked FROM onchain_supply",
      )
      .bind(onchainActiveWindowStart)
      .first<{ latest: number | null; tracked: number }>();
    onchainSupplyLatestAt = monitor?.latest ?? null;
    onchainSupplyTrackedCoins = monitor?.tracked ?? 0;

    if (
      onchainSupplyLatestAt != null &&
      now - onchainSupplyLatestAt <= STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC &&
      onchainSupplyTrackedCoins > 0
    ) {
      onchainSupplyMonitoring = "active";
      onchainSupplyQueryStatus = "ok";
    }
  } catch (e) {
    onchainSupplyQueryStatus = "failed";
    recordDataQualityFailure(sourceFailures, "onchain-supply", e);
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "onchain_supply_monitor_query_failed",
      route: "status",
      source: "onchain_supply",
      message: "Failed to query on-chain supply monitor state",
      error: e,
    });
  }

  if (onchainSupplyMonitoring === "active") {
    try {
      const stale = await db
        .prepare(
          `SELECT COUNT(*) as cnt
           FROM (
             SELECT stablecoin_id, MAX(updated_at) as latest_update
             FROM onchain_supply
             WHERE updated_at >= ?
             GROUP BY stablecoin_id
             HAVING latest_update < ?
           )`,
        )
        .bind(onchainActiveWindowStart, now - STATUS_ONCHAIN_FRESH_WINDOW_SEC)
        .first<{ cnt: number }>();
      if (stale) staleOnchainSupply = stale.cnt;
    } catch (e) {
      onchainSupplyQueryStatus = "failed";
      recordDataQualityFailure(sourceFailures, "onchain-supply", e);
      logWorkerEvent({
        scope: "status",
        level: "error",
        event: "stale_onchain_supply_query_failed",
        route: "status",
        source: "onchain_supply",
        message: "Failed to query stale on-chain supply",
        error: e,
      });
    }

    try {
      const onchainRows = await db
        .prepare(
          "SELECT stablecoin_id, SUM(supply) as total_supply FROM onchain_supply WHERE updated_at > ? GROUP BY stablecoin_id",
        )
        .bind(now - STATUS_ONCHAIN_FRESH_WINDOW_SEC)
        .all<{ stablecoin_id: string; total_supply: number }>();

      if (onchainRows.results && onchainRows.results.length > 0) {
        for (const row of onchainRows.results) {
          const asset = stablecoinAssetMap.get(row.stablecoin_id);
          if (!asset?.price || asset.price <= 0 || !asset.circulating) continue;
          const llamaSupply = getCirculatingRaw(asset) / asset.price;
          if (llamaSupply > 0) {
            const divergence = Math.abs(row.total_supply - llamaSupply) / llamaSupply;
            if (divergence > STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD) onchainSupplyDivergences++;
          }
        }
      }
    } catch (e) {
      onchainSupplyQueryStatus = "failed";
      recordDataQualityFailure(sourceFailures, "onchain-supply", e);
      logWorkerEvent({
        scope: "status",
        level: "error",
        event: "onchain_supply_divergence_query_failed",
        route: "status",
        source: "onchain_supply",
        message: "Failed to check on-chain supply divergences",
        error: e,
      });
    }
  }

  return {
    stablecoinsCacheStatus: stablecoinsCacheResult.kind,
    stablecoinsCacheReason: stablecoinsCacheResult.kind === "ok" ? null : stablecoinsCacheResult.reason,
    blacklistGapStatus,
    activeDepegStatus,
    onchainSupplyQueryStatus,
    repairDebt,
    ddrRepairDebtStatus,
    ddrRepairDebtCount,
    ddrRepairDebtCheckedAt,
    ddrRepairDebtEvents,
    ddrRepairDebtEventsTruncated,
    sourceFailures,
    totalStablecoins,
    missingPrices,
    stablecoinPublication,
    blacklistMissingAmounts,
    blacklistRecentMissingAmounts,
    blacklistRecentWindowSec: BLACKLIST_RECENT_WINDOW_SEC,
    blacklistMissingRatio: blacklistTotal > 0 ? blacklistMissingAmounts / blacklistTotal : 0,
    blacklistTotal,
    blacklistOldestRecoverableAgeSec,
    blacklistNeverAttemptedCount,
    blacklistRepeatedFailureCount,
    blacklistReconciliation,
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
