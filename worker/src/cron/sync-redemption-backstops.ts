import { getConfiguredRedemptionBackstopIds, getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { CronResult } from "../lib/cron-logger";
import { batchExecute } from "../lib/db";
import { loadDexLiquiditySnapshot } from "../lib/dex-liquidity";
import { loadReserveSyncStateMap } from "../lib/live-reserves-store";
import { upsertRedemptionBackstopSnapshots } from "../lib/redemption-backstops-store";
import {
  buildFailedRedemptionBackstopEntry,
  buildRedemptionBackstopEntry,
  resolveRedemptionBackstopEntry,
} from "../lib/redemption-backstop-sources";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";

function configNeedsReserveSyncState(config: NonNullable<ReturnType<typeof getRedemptionBackstopConfig>>): boolean {
  return (
    config.capacityModel.kind === "reserve-sync-metadata"
    || (config.costModel.kind === "dynamic-or-unclear" && config.costModel.confidence === "formula")
  );
}

async function pruneRemovedRedemptionBackstops(
  db: D1Database,
  configuredIds: readonly string[],
): Promise<void> {
  const configuredIdSet = new Set(configuredIds);
  const existingRows = await db.prepare("SELECT stablecoin_id FROM redemption_backstop").all<{ stablecoin_id: string }>();
  const staleIds = (existingRows.results ?? [])
    .map((row) => row.stablecoin_id)
    .filter((stablecoinId) => !configuredIdSet.has(stablecoinId));

  if (staleIds.length === 0) return;

  await batchExecute(
    db,
    staleIds.map((stablecoinId) => db.prepare("DELETE FROM redemption_backstop WHERE stablecoin_id = ?").bind(stablecoinId)),
  );
}

export async function syncRedemptionBackstops(db: D1Database, signal: AbortSignal): Promise<CronResult> {
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
  const configById = new Map(
    configuredIds.map((stablecoinId) => [stablecoinId, getRedemptionBackstopConfig(stablecoinId)]),
  );
  const stablecoinAssetById = new Map(stablecoinsCache.payload.peggedAssets.map((asset) => [asset.id, asset]));
  const { map: dexLiquidityMap, latestUpdatedAt } = await loadDexLiquiditySnapshot(db);
  const now = Math.floor(Date.now() / 1000);
  const reserveSyncStateById = await loadReserveSyncStateMap(
    db,
    configuredIds.filter(
      (stablecoinId) => {
        const config = configById.get(stablecoinId);
        return !!config && configNeedsReserveSyncState(config);
      },
    ),
  );

  let liquidityStale = false;
  if (latestUpdatedAt != null) {
    const ageSec = now - latestUpdatedAt;
    if (ageSec > 3600) {
      console.warn(`[sync-redemption-backstops] Liquidity data is stale (age: ${ageSec}s)`);
      liquidityStale = true;
    }
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
        resolved = await resolveRedemptionBackstopEntry(db, asset, dexLiquidityScore, now, {
          reserveSyncState: reserveSyncStateById.get(stablecoinId) ?? null,
          suppressEffectiveExitScore: liquidityStale,
        });
      } else {
        const config = configById.get(stablecoinId);
        if (config) {
          resolved = await buildRedemptionBackstopEntry(db, stablecoinId, config, null, dexLiquidityScore, now, {
            reserveSyncState: reserveSyncStateById.get(stablecoinId) ?? null,
            suppressEffectiveExitScore: liquidityStale,
          });
        }
      }

      if (resolved) snapshots.push(resolved);
    } catch (error) {
      console.error(`[sync-redemption-backstops] Failed for ${stablecoinId}:`, error);
      failedIds.push(stablecoinId);
      const config = configById.get(stablecoinId);
      if (config) {
        snapshots.push(buildFailedRedemptionBackstopEntry(stablecoinId, config, now));
      }
    }
  }

  await upsertRedemptionBackstopSnapshots(db, snapshots);
  await pruneRemovedRedemptionBackstops(db, configuredIds);

  const dynamicCount = snapshots.filter((entry) => entry.sourceMode === "dynamic").length;
  const estimatedCount = snapshots.filter((entry) => entry.sourceMode === "estimated").length;
  const staticCount = snapshots.filter((entry) => entry.sourceMode === "static").length;
  const resolvedCount = snapshots.filter((entry) => entry.resolutionState === "resolved").length;
  const unresolvedCount = snapshots.length - resolvedCount;
  const missingFromCache = configuredIds.filter((stablecoinId) => !stablecoinAssetById.has(stablecoinId));
  const coverageRatio = configuredIds.length > 0 ? resolvedCount / configuredIds.length : 1;

  const status: CronResult["status"] =
    resolvedCount === 0 && (failedIds.length > 0 || missingFromCache.length > 0 || unresolvedCount > 0)
      ? "error"
      : failedIds.length > 0 || missingFromCache.length > 0 || unresolvedCount > 0 || liquidityStale
        ? "degraded"
        : "ok";

  return {
    status,
    itemCount: snapshots.length,
    metadata: JSON.stringify({
      synced: snapshots.length,
      failed: failedIds.length,
      configured: configuredIds.length,
      resolved: resolvedCount,
      unresolved: unresolvedCount,
      coverageRatio,
      dynamic: dynamicCount,
      estimated: estimatedCount,
      static: staticCount,
      liquidityStale,
      ...(failedIds.length > 0 ? { failedIds } : {}),
      ...(missingFromCache.length > 0 ? { missingFromCache } : {}),
    }),
  };
}
