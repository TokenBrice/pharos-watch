import { logWorkerEventArgs } from "../../lib/structured-log";
import type { PeggedAsset } from "./enrich-prices";
import { queuePendingTrackedStablecoinAdditions } from "../../telegram/digest/digest-appendices";

/**
 * A DefiLlama-outage publication observes only the subset CoinGecko can price;
 * the rest of its tracked set is restored from the previous publication, and
 * coins the restore cannot vouch for are still omitted. Its asset list is not
 * the tracked-set baseline: treating it as one announces those omitted coins as
 * newly tracked. Restored rows therefore count with the CoinGecko rows.
 */
export function isFallbackBackedTrackedBaseline(
  previousAssets: Iterable<Pick<PeggedAsset, "supplySource" | "supplyRestored">>,
): boolean {
  let total = 0;
  let fallbackRows = 0;
  for (const asset of previousAssets) {
    total++;
    if (asset.supplySource === "coingecko-fallback" || asset.supplyRestored === true) fallbackRows++;
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
