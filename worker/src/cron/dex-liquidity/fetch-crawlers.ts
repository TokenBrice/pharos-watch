import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  onchainRateLimit, fetchCgTokenPools, CG_CHAIN_MAP,
} from "../../lib/coingecko-onchain";
import { GT_CHAIN_MAP } from "../../lib/chain-registry";
import { RATE_LIMITS, CRAWL_BUDGETS } from "../../lib/rate-limit";
import { sleepWithSignal } from "../../lib/abort";
import { logCronEvent, type CronEventInput } from "../../lib/cron-logger";
import type {
  LiquidityMetrics, DexPriceObs, GtCrawlResult, GtNewPool, CgNewPool,
} from "./types";
import { fetchGtTokenPools, getGtPoolType, parseGtPool } from "./geckoterminal-shared";
import { classifyCgPool, parseCgPool } from "./coingecko-onchain-shared";
import {
  getGtDexQuality,
} from "./pool-helpers";
import { buildChainAddresses, type ProviderChainAddress } from "./fetch-primary";
import { crawlTokenPools, type CrawlStats, type CrawlToken } from "./crawl-helpers";
import { addSecondaryPoolContribution } from "./pool-contribution";

type DexCrawlerEvent = Omit<CronEventInput, "job">;

async function logDexCrawlerEvent(db: D1Database | undefined, event: DexCrawlerEvent): Promise<void> {
  if (!db) return;
  await logCronEvent(db, { job: "sync-dex-liquidity", ...event });
}

function buildCrawlTokens(chainAddresses: Map<string, ProviderChainAddress[]>): CrawlToken[] {
  const tokens: CrawlToken[] = [];
  for (const [sourceChain, contracts] of chainAddresses) {
    for (const { chain, address, stablecoinId } of contracts) {
      tokens.push({ sourceChain, ourChain: chain, address, stablecoinId });
    }
  }
  return tokens;
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

/** Crawl CG onchain pools for all tracked stablecoins.
 *  Budgeted so CG + GT-only crawls still leave room for scoring/persistence. */
export async function fetchCgPools(
  chainAddressToId: Map<string, string>,
  knownPoolAddrs: Set<string>,
  protocolTvlCaps: Map<string, number>,
  signal?: AbortSignal,
  chainAddresses: Map<string, ProviderChainAddress[]> = buildChainAddresses(CG_CHAIN_MAP),
  deadlineMs?: number,
  coingeckoApiKey?: string | null,
  db?: D1Database,
): Promise<{ newPools: Map<string, CgNewPool[]>; priceObs: Map<string, DexPriceObs[]>; stats: GtCrawlResult["stats"] }> {
  const newPools = new Map<string, CgNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const stats: CrawlStats = { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0, poolsSkippedRatio: 0 };
  const allTokens = buildCrawlTokens(chainAddresses);

  await crawlTokenPools({
    sourceLabel: "CG",
    tokens: allTokens,
    chainAddressToId,
    knownPoolAddrs,
    protocolTvlCaps,
    newPools,
    priceObs,
    stats,
    signal,
    beforeRequest: async ({ requestCount, totalTokens, startMs, signal: abortSignal }) => {
      if (deadlineMs && Date.now() >= deadlineMs) {
        await logDexCrawlerEvent(db, {
          eventType: "cg-pool-crawl-deadline-reached",
          severity: "warning",
          message: "CoinGecko pool crawl shared deadline reached; yielding partial results.",
          metadata: { requestCount, totalTokens },
        });
        return false;
      }
      if (Date.now() - startMs > CRAWL_BUDGETS.COINGECKO_ONCHAIN_MS) {
        await logDexCrawlerEvent(db, {
          eventType: "cg-pool-crawl-budget-exhausted",
          severity: "warning",
          message: "CoinGecko pool crawl time budget exhausted; yielding partial results.",
          metadata: {
            requestCount,
            totalTokens,
            elapsedSeconds: Math.round((Date.now() - startMs) / 1000),
          },
        });
        return false;
      }
      await onchainRateLimit(requestCount, abortSignal);
      return true;
    },
    fetchPools: (tokenAddress, cgChain, abortSignal) => fetchCgTokenPools(cgChain, tokenAddress, abortSignal, coingeckoApiKey ?? null),
    parsePool: parseCgPool,
    buildNewPool: ({ rawPool, parsed, chain, price, cappedTvlUsd, maturityDays }) => {
      const {
        qualityMultiplier,
        poolType,
        feePercentage,
        lockedLiquidityPct,
        balanceRatio,
      } = classifyCgPool(parsed, rawPool.attributes);

      return {
        address: parsed.poolAddress,
        chain,
        dexId: parsed.dexId,
        name: parsed.poolName,
        tvlUsd: cappedTvlUsd,
        volume24hUsd: parsed.volume24hUsd,
        qualityMultiplier,
        maturityDays,
        poolType,
        price,
        symbol: parsed.poolName,
        sourceFamily: "cg_onchain",
        balanceRatio,
        lockedLiquidityPct,
        feePercentage,
        measurement: {
          tvlMeasured: true,
          volumeMeasured: true,
          balanceMeasured: balanceRatio != null,
          maturityMeasured: maturityDays > 0,
          priceMeasured: price > 0,
          synthetic: false,
        },
      };
    },
  });

  await logDexCrawlerEvent(db, {
    eventType: "cg-pool-crawl-completed",
    severity: "info",
    message: "CoinGecko pool crawl completed.",
    metadata: {
      requests: stats.requests,
      totalTokens: allTokens.length,
      poolsSeen: stats.poolsSeen,
      poolsNew: stats.poolsNew,
      poolsSkippedCurve: stats.poolsSkippedCurve,
      poolsSkippedKnown: stats.poolsSkippedKnown,
      poolsSkippedRatio: stats.poolsSkippedRatio,
    },
  });
  return { newPools, priceObs, stats };
}

/** Merge CG-discovered new pools into existing LiquidityMetrics.
 *  Unlike GT pools, CG pools can contribute real balance ratios and locked liquidity. */
export function mergeCgPools(
  metrics: Map<string, LiquidityMetrics>,
  cgNewPools: Map<string, CgNewPool[]>,
  db?: D1Database,
): void {
  let withBalance = 0;
  const merged = mergeSecondaryPools(metrics, cgNewPools, {
    onPoolMerged: (pool) => {
      if (pool.balanceRatio != null) withBalance++;
    },
  });

  if (merged > 0) {
    void logDexCrawlerEvent(db, {
      eventType: "cg-pools-merged",
      severity: "info",
      message: "Merged CoinGecko pools into liquidity metrics.",
      metadata: { merged, stablecoins: cgNewPools.size, withBalance },
    });
  }
}

/** Crawl GT pools for all tracked stablecoins, dedup against known pools.
 *  Returns new pool data and price observations. */
export async function fetchGtPools(
  chainAddressToId: Map<string, string>,
  knownPoolAddrs: Set<string>,
  protocolTvlCaps: Map<string, number>,
  signal?: AbortSignal,
  chainAddresses: Map<string, ProviderChainAddress[]> = buildChainAddresses(GT_CHAIN_MAP),
  deadlineMs?: number,
  db?: D1Database,
): Promise<GtCrawlResult> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const stats: CrawlStats = { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0, poolsSkippedRatio: 0 };
  const allTokens = buildCrawlTokens(chainAddresses);

  // Fisher-Yates shuffle
  for (let i = allTokens.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allTokens[i], allTokens[j]] = [allTokens[j], allTokens[i]];
  }

  const { stoppedEarly } = await crawlTokenPools({
    sourceLabel: "GT",
    tokens: allTokens,
    chainAddressToId,
    knownPoolAddrs,
    protocolTvlCaps,
    newPools,
    priceObs,
    stats,
    signal,
    beforeRequest: async ({ requestCount, totalTokens, startMs, signal: abortSignal }) => {
      if (deadlineMs && Date.now() >= deadlineMs) {
        await logDexCrawlerEvent(db, {
          eventType: "gt-pool-crawl-deadline-reached",
          severity: "warning",
          message: "GeckoTerminal pool crawl shared deadline reached; yielding partial results.",
          metadata: { requestCount, totalTokens },
        });
        return false;
      }
      if (Date.now() - startMs > CRAWL_BUDGETS.GECKO_TERMINAL_MS) {
        await logDexCrawlerEvent(db, {
          eventType: "gt-pool-crawl-budget-exhausted",
          severity: "warning",
          message: "GeckoTerminal pool crawl time budget exhausted; yielding partial results.",
          metadata: {
            requestCount,
            totalTokens,
            elapsedSeconds: Math.round((Date.now() - startMs) / 1000),
          },
        });
        return false;
      }
      if (requestCount > 0) {
        await sleepWithSignal(RATE_LIMITS.GECKO_TERMINAL_MS, abortSignal);
      }
      return true;
    },
    fetchPools: fetchGtTokenPools,
    parsePool: parseGtPool,
    buildNewPool: ({ parsed, chain, price, cappedTvlUsd, maturityDays }) => {
      return {
        address: parsed.poolAddress,
        chain,
        dexId: parsed.dexId,
        name: parsed.poolName,
        tvlUsd: cappedTvlUsd,
        volume24hUsd: parsed.volume24hUsd,
        qualityMultiplier: getGtDexQuality(parsed.dexId),
        maturityDays,
        poolType: getGtPoolType(parsed.dexId),
        price,
        symbol: parsed.poolName,
        sourceFamily: "gecko_terminal",
        measurement: {
          tvlMeasured: true,
          volumeMeasured: true,
          balanceMeasured: false,
          maturityMeasured: maturityDays > 0,
          priceMeasured: price > 0,
          synthetic: false,
        },
      };
    },
  });

  if (stoppedEarly) {
    return { newPools, priceObs, stats };
  }

  await logDexCrawlerEvent(db, {
    eventType: "gt-pool-crawl-completed",
    severity: "info",
    message: "GeckoTerminal pool crawl completed.",
    metadata: {
      requests: stats.requests,
      totalTokens: allTokens.length,
      poolsSeen: stats.poolsSeen,
      poolsNew: stats.poolsNew,
      poolsSkippedCurve: stats.poolsSkippedCurve,
      poolsSkippedKnown: stats.poolsSkippedKnown,
      poolsSkippedRatio: stats.poolsSkippedRatio,
    },
  });
  return { newPools, priceObs, stats };
}

/** Merge GT-discovered new pools into existing LiquidityMetrics. */
export function mergeGtPools(
  metrics: Map<string, LiquidityMetrics>,
  gtNewPools: Map<string, GtNewPool[]>,
  db?: D1Database,
): void {
  const merged = mergeSecondaryPools(metrics, gtNewPools);

  if (merged > 0) {
    void logDexCrawlerEvent(db, {
      eventType: "gt-pools-merged",
      severity: "info",
      message: "Merged GeckoTerminal-compatible pools into liquidity metrics.",
      metadata: { merged, stablecoins: gtNewPools.size },
    });
  }
}
