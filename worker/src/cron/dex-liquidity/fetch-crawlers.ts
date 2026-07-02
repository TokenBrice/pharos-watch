import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { logCronEvent, type CronEventInput } from "../../lib/cron-logger";
import type {
  LiquidityMetrics, GtNewPool, CgNewPool,
} from "./types";
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
  },
): number {
  let merged = 0;

  for (const [stablecoinId, pools] of discoveredPools) {
    const meta = TRACKED_META_BY_ID.get(stablecoinId);
    if (!meta) continue;

    for (const pool of pools) {
      addSecondaryPoolContribution(metrics, stablecoinId, meta.symbol, pool);
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
): Promise<void> {
  let withBalance = 0;
  const merged = mergeSecondaryPools(metrics, cgNewPools, {
    onPoolMerged: (pool) => {
      if (pool.balanceRatio != null) withBalance++;
    },
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
): Promise<void> {
  const merged = mergeSecondaryPools(metrics, gtNewPools);

  if (merged > 0) {
    await logDexCrawlerEvent(db, {
      eventType: "gt-pools-merged",
      severity: "info",
      message: "Merged GeckoTerminal-compatible pools into liquidity metrics.",
      metadata: { merged, stablecoins: gtNewPools.size },
    });
  }
}
