import { logWorkerEventArgs } from "../../lib/structured-log";
import type { PeggedAsset } from "./enrich-prices";
import { queuePendingTrackedStablecoinAdditions } from "../../lib/telegram/digest-appendices";

export async function queueTrackedAdditionsNotice(
  db: D1Database,
  previousAssetIds: Iterable<string>,
  assets: PeggedAsset[],
): Promise<void> {
  try {
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
