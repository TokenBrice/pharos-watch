import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { logCronEvent, type CronEventInput } from "../../lib/cron-logger";
import type { LiquidityFallbackCounters, LiquidityMetrics, PoolEntry, GtNewPool, CgNewPool } from "./types";
import { addSecondaryPoolContribution } from "./pool-contribution";

type DexCrawlerEvent = Omit<CronEventInput, "job">;

async function logDexCrawlerEvent(db: D1Database | undefined, event: DexCrawlerEvent): Promise<void> {
  if (!db) return;
  await logCronEvent(db, { job: "sync-dex-liquidity", ...event });
}

function mergeSecondaryPools<TPool extends GtNewPool | CgNewPool>(
  metrics: Map<string, LiquidityMetrics>,
  discoveredPools: Map<string, TPool[]>,
  options?: {
    onPoolMerged?: (pool: TPool) => void;
    fallbackCounters?: LiquidityFallbackCounters;
  },
): number {
  let merged = 0;

  for (const [stablecoinId, pools] of discoveredPools) {
    const meta = TRACKED_META_BY_ID.get(stablecoinId);
    if (!meta) continue;
    const poolIndex = new Map<string, PoolEntry>();
    for (const pool of metrics.get(stablecoinId)?.topPools ?? []) {
      const poolId = pool.poolId;
      if (!poolIndex.has(poolId)) poolIndex.set(poolId, pool);
    }

    for (const pool of pools) {
      addSecondaryPoolContribution(metrics, stablecoinId, meta.symbol, pool, poolIndex, options?.fallbackCounters);
      options?.onPoolMerged?.(pool);
      merged++;
    }
  }

  return merged;
}

/** Merge CG-discovered new pools into existing LiquidityMetrics.
 *  Unlike GT pools, CG pools can contribute real balance ratios and locked liquidity. */
export async function mergeCgPools(
  metrics: Map<string, LiquidityMetrics>,
  cgNewPools: Map<string, CgNewPool[]>,
  db?: D1Database,
  fallbackCounters?: LiquidityFallbackCounters,
): Promise<void> {
  let withBalance = 0;
  const merged = mergeSecondaryPools(metrics, cgNewPools, {
    onPoolMerged: (pool) => {
      if (pool.balanceRatio != null) withBalance++;
    },
    fallbackCounters,
  });

  if (merged > 0) {
    await logDexCrawlerEvent(db, {
      eventType: "cg-pools-merged",
      severity: "info",
      message: "Merged CoinGecko pools into liquidity metrics.",
      metadata: { merged, stablecoins: cgNewPools.size, withBalance },
    });
  }
}

/** Merge GT-discovered new pools into existing LiquidityMetrics. */
export async function mergeGtPools(
  metrics: Map<string, LiquidityMetrics>,
  gtNewPools: Map<string, GtNewPool[]>,
  db?: D1Database,
  fallbackCounters?: LiquidityFallbackCounters,
): Promise<void> {
  const merged = mergeSecondaryPools(metrics, gtNewPools, { fallbackCounters });

  if (merged > 0) {
    await logDexCrawlerEvent(db, {
      eventType: "gt-pools-merged",
      severity: "info",
      message: "Merged GeckoTerminal-compatible pools into liquidity metrics.",
      metadata: { merged, stablecoins: gtNewPools.size },
    });
  }
}
