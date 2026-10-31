import { logWorkerEventArgs } from "../../lib/structured-log";
import type { PeggedAsset } from "./enrich-prices";
import { queuePendingTrackedStablecoinAdditions } from "../../telegram/digest/digest-appendices";

/**
 * A CoinGecko-only publication serves the subset it can price, so its asset
 * list is not the tracked-set baseline: treating it as one announces every
 * tracked coin the outage omitted as newly tracked.
 */
export function isFallbackBackedTrackedBaseline(
  previousAssets: Iterable<Pick<PeggedAsset, "supplySource">>,
): boolean {
  let total = 0;
  let fallbackRows = 0;
  for (const asset of previousAssets) {
    total++;
    if (asset.supplySource === "coingecko-fallback") fallbackRows++;
  }
  return fallbackRows * 2 > total;
}

export async function queueTrackedAdditionsNotice(
  db: D1Database,
  previousAssetIds: Iterable<string>,
  assets: PeggedAsset[],
  options: { previousBaselineFallbackBacked?: boolean } = {},
): Promise<void> {
  try {
    if (options.previousBaselineFallbackBacked) {
      logWorkerEventArgs("handler", "info",
        "[sync-stablecoins] Skipping Telegram tracked additions: previous publication was a CoinGecko fallback cohort",
      );
      return;
    }
    const trackedAdditions = await queuePendingTrackedStablecoinAdditions(
      db,
      previousAssetIds,
      assets.map((asset) => String(asset.id)),
    );
    if (trackedAdditions.queuedIds.length > 0) {
      logWorkerEventArgs("handler", "info",
        `[sync-stablecoins] Queued Telegram tracked additions: ${trackedAdditions.queuedIds.join(", ")}`,
      );
    }
  } catch (err) {
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Failed to queue Telegram tracked additions:", err);
  }
}
