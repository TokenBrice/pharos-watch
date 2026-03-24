import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  onchainRateLimit, fetchCgTokenPools, CG_CHAIN_MAP,
} from "../../lib/coingecko-onchain";
import { GT_CHAIN_MAP } from "../../lib/chain-registry";
import { RATE_LIMITS, CRAWL_BUDGETS } from "../../lib/rate-limit";
import { sleepWithSignal } from "../../lib/abort";
import type {
  LiquidityMetrics, DexPriceObs, GtCrawlResult, GtNewPool, CgNewPool,
} from "./types";
import { fetchGtTokenPools, getGtPoolType, parseGtPool } from "./geckoterminal-shared";
import { classifyCgPool, parseCgPool } from "./coingecko-onchain-shared";
import {
  getGtDexQuality,
  initMetrics,
} from "./pool-helpers";
import { buildChainAddresses, type ProviderChainAddress } from "./fetch-primary";
import { crawlTokenPools, type CrawlStats, type CrawlToken } from "./crawl-helpers";
import { addSecondaryPoolContribution } from "./pool-contribution";

function buildCrawlTokens(chainAddresses: Map<string, ProviderChainAddress[]>): CrawlToken[] {
  const tokens: CrawlToken[] = [];
  for (const [sourceChain, contracts] of chainAddresses) {
    for (const { chain, address, stablecoinId } of contracts) {
      tokens.push({ sourceChain, ourChain: chain, address, stablecoinId });
    }
  }
  return tokens;
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
        console.log(
          `[dex-liquidity] CG pool crawl shared deadline reached after ${requestCount}/${totalTokens} requests, yielding partial results`,
        );
        return false;
      }
      if (Date.now() - startMs > CRAWL_BUDGETS.COINGECKO_ONCHAIN_MS) {
        console.log(
          `[dex-liquidity] CG pool crawl time budget exhausted after ${requestCount}/${totalTokens} requests ` +
          `(${Math.round((Date.now() - startMs) / 1000)}s), yielding partial results`,
        );
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

  console.log(
    `[dex-liquidity] CG pool crawl: ${stats.requests}/${allTokens.length} requests, ${stats.poolsSeen} pools seen, ` +
    `${stats.poolsNew} new, ${stats.poolsSkippedCurve} skipped (Curve), ${stats.poolsSkippedKnown} skipped (known), ${stats.poolsSkippedRatio} skipped (vol/TVL ratio)`
  );
  return { newPools, priceObs, stats };
}

/** Merge CG-discovered new pools into existing LiquidityMetrics.
 *  Unlike GT pools, CG pools can contribute real balance ratios and locked liquidity. */
export function mergeCgPools(
  metrics: Map<string, LiquidityMetrics>,
  cgNewPools: Map<string, CgNewPool[]>,
): void {
  let merged = 0;
  let withBalance = 0;

  for (const [stablecoinId, pools] of cgNewPools) {
    const meta = TRACKED_META_BY_ID.get(stablecoinId);
    if (!meta) continue;

    let m = metrics.get(stablecoinId);
    if (!m) {
      m = initMetrics(stablecoinId, meta.symbol);
      metrics.set(stablecoinId, m);
    }

    for (const pool of pools) {
      addSecondaryPoolContribution(metrics, stablecoinId, meta.symbol, pool);
      m = metrics.get(stablecoinId)!;
      if (pool.balanceRatio != null) withBalance++;
      merged++;
    }
  }

  if (merged > 0) {
    console.log(`[dex-liquidity] Merged ${merged} CG pools into ${cgNewPools.size} stablecoins (${withBalance} with balance data)`);
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
        console.log(
          `[dex-liquidity] GT pool crawl shared deadline reached after ${requestCount}/${totalTokens} requests, yielding partial results`,
        );
        return false;
      }
      if (Date.now() - startMs > CRAWL_BUDGETS.GECKO_TERMINAL_MS) {
        console.log(
          `[dex-liquidity] GT pool crawl time budget exhausted after ${requestCount}/${totalTokens} requests ` +
          `(${Math.round((Date.now() - startMs) / 1000)}s), yielding partial results`,
        );
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

  console.log(
    `[dex-liquidity] GT pool crawl: ${stats.requests}/${allTokens.length} requests, ${stats.poolsSeen} pools seen, ` +
    `${stats.poolsNew} new, ${stats.poolsSkippedCurve} skipped (Curve), ${stats.poolsSkippedKnown} skipped (known), ${stats.poolsSkippedRatio} skipped (vol/TVL ratio)`
  );
  return { newPools, priceObs, stats };
}

/** Merge GT-discovered new pools into existing LiquidityMetrics. */
export function mergeGtPools(
  metrics: Map<string, LiquidityMetrics>,
  gtNewPools: Map<string, GtNewPool[]>,
): void {
  let merged = 0;

  for (const [stablecoinId, pools] of gtNewPools) {
    const meta = TRACKED_META_BY_ID.get(stablecoinId);
    if (!meta) continue;

    let m = metrics.get(stablecoinId);
    if (!m) {
      m = initMetrics(stablecoinId, meta.symbol);
      metrics.set(stablecoinId, m);
    }

    for (const pool of pools) {
      addSecondaryPoolContribution(metrics, stablecoinId, meta.symbol, pool);
      m = metrics.get(stablecoinId)!;
      merged++;
    }
  }

  if (merged > 0) {
    console.log(`[dex-liquidity] Merged ${merged} GT pools into ${gtNewPools.size} stablecoins`);
  }
}
