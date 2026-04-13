import { queryBlacklistGapMetrics } from "../blacklist-gaps";
import type { BlacklistGapMetrics } from "../blacklist-gaps";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../stablecoins-cache";
import {
  BLACKLIST_RECENT_WINDOW_SEC,
  STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD,
  STATUS_ONCHAIN_FRESH_WINDOW_SEC,
  STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC,
} from "@shared/lib/status-thresholds";
import { ACTIVE_IDS } from "@shared/lib/stablecoins";
import type { DataQuality, StatusResponse } from "@shared/types/status";

type DataQualitySourceKey = StatusResponse["dataQuality"]["sourceFailures"][number]["source"];

function recordDataQualityFailure(
  bucket: StatusResponse["dataQuality"]["sourceFailures"],
  source: DataQualitySourceKey,
  _err: unknown,
): void {
  if (bucket.some((entry) => entry.source === source)) {
    return;
  }
  const message =
    source === "stablecoins-cache"
      ? "Stablecoins cache unavailable."
      : source === "blacklist-gaps"
        ? "Blacklist gap metrics unavailable."
        : source === "active-depegs"
          ? "Active depeg metrics unavailable."
          : "Onchain supply diagnostics unavailable.";
  bucket.push({
    source,
    message,
  });
}

export function emptyDataQuality(): DataQuality {
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
    blacklistOldestRecoverableAgeSec: null,
    blacklistNeverAttemptedCount: 0,
    blacklistRepeatedFailureCount: 0,
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
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
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

  // Scope `missingPriceRatio` denominator to active canonical stablecoins
  // only. The DL stablecoins API emits residuals (numeric IDs not in
  // canonical-order.json) that ride in the cache but are not actively
  // tracked, and pre-launch canonical coins legitimately have no price yet.
  // Counting either inflates the ratio and drives false degradations.
  // See agents/research/2026-04-13-missing-price-coins-audit.md.
  const activeCanonicalAssets = stablecoinAssets.filter((asset) => ACTIVE_IDS.has(asset.id));
  const totalStablecoins = activeCanonicalAssets.length;
  const missingPrices = activeCanonicalAssets.filter(
    (asset: { price?: number | null }) => asset.price == null || asset.price === 0,
  ).length;

  let blacklistTotal = 0;
  let blacklistMissingAmounts = 0;
  let blacklistRecentMissingAmounts = 0;
  let blacklistOldestRecoverableAgeSec: number | null = null;
  let blacklistNeverAttemptedCount = 0;
  let blacklistRepeatedFailureCount = 0;
  let blacklistGapStatus: DataQuality["blacklistGapStatus"] = "ok";
  try {
    const gaps = options?.blacklistMetrics ?? await queryBlacklistGapMetrics(db, now, BLACKLIST_RECENT_WINDOW_SEC);
    blacklistTotal = gaps.totalEvents;
    blacklistMissingAmounts = gaps.missingAmounts;
    blacklistRecentMissingAmounts = gaps.recentMissingAmounts;
    blacklistOldestRecoverableAgeSec = gaps.oldestRecoverableAgeSec;
    blacklistNeverAttemptedCount = gaps.neverAttemptedCount;
    blacklistRepeatedFailureCount = gaps.repeatedFailureCount;
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
      onchainSupplyLatestAt != null
      && now - onchainSupplyLatestAt <= STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC
      && onchainSupplyTrackedCoins > 0
    ) {
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
      console.error("[status] Failed to query stale on-chain supply:", e);
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
          const llamaValues = Object.values(asset.circulating);
          const llamaTotal = llamaValues.reduce((sum, value) => sum + (value ?? 0), 0);
          const llamaSupply = llamaTotal / asset.price;
          if (llamaSupply > 0) {
            const divergence = Math.abs(row.total_supply - llamaSupply) / llamaSupply;
            if (divergence > STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD) onchainSupplyDivergences++;
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
    blacklistOldestRecoverableAgeSec,
    blacklistNeverAttemptedCount,
    blacklistRepeatedFailureCount,
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
