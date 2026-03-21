import type { PeggedAsset } from "../enrich-prices";
import { queuePendingTrackedStablecoinAdditions } from "../../lib/telegram-digest-appendices";

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
      console.log(
        `[sync-stablecoins] Queued Telegram tracked additions: ${trackedAdditions.queuedIds.join(", ")}`,
      );
    }
  } catch (err) {
    console.warn("[sync-stablecoins] Failed to queue Telegram tracked additions:", err);
  }
}
