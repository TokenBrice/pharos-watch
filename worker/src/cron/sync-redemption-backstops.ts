import { getConfiguredRedemptionBackstopIds } from "@shared/lib/redemption-backstops";
import type { CronResult } from "../lib/cron-logger";
import { buildInClause } from "../lib/db";
import { loadDexLiquidityMap } from "../lib/dex-liquidity";
import {
  upsertRedemptionBackstopSnapshots,
} from "../lib/redemption-backstops-store";
import { resolveRedemptionBackstopEntry } from "../lib/redemption-backstop-sources";
import {
  hasUsableStablecoinsPayload,
  loadStablecoinsCache,
} from "../lib/stablecoins-cache";

export async function syncRedemptionBackstops(
  db: D1Database,
  signal: AbortSignal,
): Promise<CronResult> {
  const stablecoinsCache = await loadStablecoinsCache(db, {
    mode: "strict",
    allowLegacyArray: true,
  });
  if (!hasUsableStablecoinsPayload(stablecoinsCache)) {
    return {
      status: "error",
      metadata: JSON.stringify({
        reason: `stablecoins-cache:${stablecoinsCache.reason}`,
      }),
    };
  }

  const configuredIds = getConfiguredRedemptionBackstopIds();
  const configuredIdSet = new Set(configuredIds);
  const stablecoinAssets = stablecoinsCache.payload.peggedAssets.filter((asset) =>
    configuredIdSet.has(asset.id),
  );
  const dexLiquidityMap = await loadDexLiquidityMap(db);
  const now = Math.floor(Date.now() / 1000);
  const snapshots = [];
  const failedIds: string[] = [];

  for (const asset of stablecoinAssets) {
    if (signal.aborted) {
      throw signal.reason ?? new Error("sync-redemption-backstops aborted");
    }

    try {
      const resolved = await resolveRedemptionBackstopEntry(
        db,
        asset,
        dexLiquidityMap[asset.id]?.liquidityScore ?? null,
        now,
      );
      if (resolved) snapshots.push(resolved);
    } catch (error) {
      console.error(
        `[sync-redemption-backstops] Failed for ${asset.id}:`,
        error,
      );
      failedIds.push(asset.id);
    }
  }

  await upsertRedemptionBackstopSnapshots(db, snapshots);

  if (configuredIds.length > 0) {
    const inClause = buildInClause(configuredIds);
    await db
      .prepare(
        `DELETE FROM redemption_backstop
         WHERE stablecoin_id NOT IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .run();
  }

  const dynamicCount = snapshots.filter(
    (entry) => entry.sourceMode === "dynamic",
  ).length;
  const estimatedCount = snapshots.filter(
    (entry) => entry.sourceMode === "estimated",
  ).length;
  const staticCount = snapshots.filter(
    (entry) => entry.sourceMode === "static",
  ).length;
  const missingFromCache = configuredIds.filter(
    (stablecoinId) => !stablecoinAssets.some((asset) => asset.id === stablecoinId),
  );

  const status: CronResult["status"] =
    snapshots.length === 0 && (failedIds.length > 0 || missingFromCache.length > 0)
      ? "error"
      : failedIds.length > 0
        ? "degraded"
        : "ok";

  return {
    status,
    itemCount: snapshots.length,
    metadata: JSON.stringify({
      synced: snapshots.length,
      failed: failedIds.length,
      configured: configuredIds.length,
      dynamic: dynamicCount,
      estimated: estimatedCount,
      static: staticCount,
      ...(failedIds.length > 0 ? { failedIds } : {}),
      ...(missingFromCache.length > 0 ? { missingFromCache } : {}),
    }),
  };
}
