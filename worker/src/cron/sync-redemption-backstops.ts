import {
  getConfiguredRedemptionBackstopIds,
  getRedemptionBackstopConfig,
} from "@shared/lib/redemption-backstops";
import type { CronResult } from "../lib/cron-logger";
import { buildInClause } from "../lib/db";
import { loadDexLiquidityMap } from "../lib/dex-liquidity";
import {
  upsertRedemptionBackstopSnapshots,
} from "../lib/redemption-backstops-store";
import {
  buildRedemptionBackstopEntry,
  resolveRedemptionBackstopEntry,
} from "../lib/redemption-backstop-sources";
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
  const stablecoinAssetById = new Map(
    stablecoinsCache.payload.peggedAssets.map((asset) => [asset.id, asset]),
  );
  const dexLiquidityMap = await loadDexLiquidityMap(db);
  const now = Math.floor(Date.now() / 1000);

  // M10: Check liquidity data staleness
  let liquidityStale = false;
  try {
    const staleness = await db.prepare("SELECT MAX(updated_at) as max_ts FROM dex_liquidity").first<{ max_ts: number | null }>();
    const maxTs = staleness?.max_ts;
    if (maxTs != null) {
      const ageSec = now - maxTs;
      if (ageSec > 3600) {
        console.warn(`[sync-redemption-backstops] Liquidity data is stale (age: ${ageSec}s)`);
        liquidityStale = true;
      }
    }
  } catch {
    // Non-blocking
  }

  const snapshots = [];
  const failedIds: string[] = [];

  for (const stablecoinId of configuredIds) {
    if (signal.aborted) {
      throw signal.reason ?? new Error("sync-redemption-backstops aborted");
    }

    try {
      const asset = stablecoinAssetById.get(stablecoinId);
      const dexLiquidityScore = dexLiquidityMap[stablecoinId]?.liquidityScore ?? null;
      let resolved = null;

      if (asset) {
        resolved = await resolveRedemptionBackstopEntry(
          db,
          asset,
          dexLiquidityScore,
          now,
        );
      } else {
        const config = getRedemptionBackstopConfig(stablecoinId);
        if (config) {
          resolved = await buildRedemptionBackstopEntry(
            db,
            stablecoinId,
            config,
            null,
            dexLiquidityScore,
            now,
          );
        }
      }

      if (resolved) snapshots.push(resolved);
    } catch (error) {
      console.error(
        `[sync-redemption-backstops] Failed for ${stablecoinId}:`,
        error,
      );
      failedIds.push(stablecoinId);
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
    (stablecoinId) => !stablecoinAssetById.has(stablecoinId),
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
      liquidityStale,
      ...(failedIds.length > 0 ? { failedIds } : {}),
      ...(missingFromCache.length > 0 ? { missingFromCache } : {}),
    }),
  };
}
