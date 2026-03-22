import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { STAGED_POOL_DEFAULTS } from "../dex-discovery/types";
import {
  onchainRateLimit, fetchCgTokenPools, CG_CHAIN_MAP,
} from "../../lib/coingecko-onchain";
import { GT_CHAIN_MAP } from "../../lib/chain-registry";
import { RATE_LIMITS, CRAWL_BUDGETS } from "../../lib/rate-limit";
import { CHAIN_META } from "@shared/lib/chains";
import { sleepWithSignal } from "../../lib/abort";
import type {
  LiquidityMetrics, DexPriceObs, GtCrawlResult, GtNewPool, CgNewPool,
} from "./types";
import { fetchGtTokenPools, getGtPoolType, parseGtPool } from "./geckoterminal-shared";
import { classifyCgPool, parseCgPool } from "./coingecko-onchain-shared";
import {
  normalizeProtocol, getGtDexQuality,
  computePoolPairQuality, computePoolStress, initMetrics,
} from "./pool-helpers";
import { buildChainAddresses, type ProviderChainAddress } from "./fetch-primary";
import { crawlTokenPools, type CrawlStats, type CrawlToken } from "./crawl-helpers";

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
      const balanceRatio = pool.balanceRatio ?? STAGED_POOL_DEFAULTS.balanceRatioFallback;
      const balanceHealth = Math.pow(balanceRatio, 1.5);
      const organicFraction = STAGED_POOL_DEFAULTS.organicFraction;
      const lockedLiquidityPct = pool.lockedLiquidityPct ?? STAGED_POOL_DEFAULTS.lockedLiquidityFallback;
      const coinPairQuality = computePoolPairQuality(
        (pool.symbol ?? "").split(/\s*\/\s*/).map((s) => s.trim()),
        meta.symbol,
      );
      const combinedQuality = pool.qualityMultiplier * balanceHealth * coinPairQuality;
      const qualityAdjustedTvl = pool.tvlUsd * pool.qualityMultiplier * balanceHealth;
      const poolEffTvl = pool.tvlUsd * combinedQuality;
      const stressIdx = computePoolStress(balanceRatio, organicFraction, pool.maturityDays, coinPairQuality);

      m.totalTvlUsd += pool.tvlUsd;
      m.totalVolume24hUsd += pool.volume24hUsd;
      m.poolCount++;
      m.chains.add(pool.chain);
      m.pairs.add(pool.symbol);
      m.qualityAdjustedTvl += qualityAdjustedTvl;
      m.effectiveTvl += poolEffTvl;
      m.stressWeightedSum += pool.tvlUsd * stressIdx;
      m.oldestPoolDays = Math.max(m.oldestPoolDays, pool.maturityDays);

      // Locked liquidity tracking (CG pools only)
      if (lockedLiquidityPct != null && lockedLiquidityPct > 0) {
        m.lockedLiqWeightedSum += pool.tvlUsd * (lockedLiquidityPct / 100);
        m.totalTvlForLocked += pool.tvlUsd;
      }

      // CG pools with real balance ratios contribute to balance tracking
      if (pool.balanceRatio != null) {
        m.balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
        m.totalTvlForBalance += pool.tvlUsd;
        withBalance++;
      }

      // Protocol and chain TVL
      const protocol = normalizeProtocol(pool.dexId);
      m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + pool.tvlUsd;
      m.chainTvl[pool.chain] = (m.chainTvl[pool.chain] ?? 0) + pool.tvlUsd;

      // Add to top pools
      m.topPools.push({
        poolId: `${pool.chain.toLowerCase()}:${pool.address.toLowerCase()}`,
        project: pool.dexId,
        chain: pool.chain,
        tvlUsd: pool.tvlUsd,
        symbol: pool.symbol,
        volumeUsd1d: pool.volume24hUsd,
        volumeUsd7d: pool.volume7dUsd ?? null,
        poolType: pool.poolType,
        source: "cg_onchain",
        ...(pool.price > 0 ? { price: pool.price } : {}),
        extra: {
          ...(pool.balanceRatio != null ? { balanceRatio: Math.round(pool.balanceRatio * 100) / 100 } : {}),
          ...(pool.feePercentage != null ? { feeTier: Math.round(pool.feePercentage * 100) } : {}),
          qualityAdjustedTvl: Math.round(qualityAdjustedTvl),
          effectiveTvl: Math.round(poolEffTvl),
          organicFraction,
          hasMeasuredOrganicFraction: false,
          pairQuality: Math.round(coinPairQuality * 100) / 100,
          stressIndex: stressIdx,
          maturityDays: pool.maturityDays,
          lockedLiquidityPct,
        },
      });

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
      const organicFraction = STAGED_POOL_DEFAULTS.organicFraction;
      const hasMeasuredBalance = pool.balanceRatio != null && Number.isFinite(pool.balanceRatio);
      const balanceRatio = hasMeasuredBalance ? pool.balanceRatio! : STAGED_POOL_DEFAULTS.balanceRatioFallback;
      const balanceHealth = hasMeasuredBalance ? Math.pow(balanceRatio, 1.5) : 1;
      // Note: GT pools intentionally excluded from balanceRatioWeightedSum and
      // organicTvlWeightedSum to avoid diluting those signals with neutral defaults.
      // Only Curve (balance) and DeFiLlama-APY (organic) pools contribute real data.
      const coinPairQuality = computePoolPairQuality(
        (pool.symbol ?? "").split(/\s*\/\s*/).map((s) => s.trim()),
        meta.symbol,
      );
      const combinedQuality = pool.qualityMultiplier * balanceHealth * coinPairQuality;
      const qualityAdjustedTvl = pool.tvlUsd * pool.qualityMultiplier * balanceHealth;
      const poolEffTvl = pool.tvlUsd * combinedQuality;
      const stressIdx = computePoolStress(balanceRatio, organicFraction, pool.maturityDays, coinPairQuality);

      // Normalize chain name to display form (e.g., "solana" → "Solana") for consistent aggregation
      const chainDisplay = CHAIN_META[pool.chain.toLowerCase()]?.name ?? pool.chain;

      m.totalTvlUsd += pool.tvlUsd;
      m.totalVolume24hUsd += pool.volume24hUsd;
      m.poolCount++;
      m.chains.add(chainDisplay);
      m.pairs.add(pool.symbol);
      m.qualityAdjustedTvl += qualityAdjustedTvl;
      m.effectiveTvl += poolEffTvl;
      m.stressWeightedSum += pool.tvlUsd * stressIdx;
      m.oldestPoolDays = Math.max(m.oldestPoolDays, pool.maturityDays);
      if (hasMeasuredBalance) {
        m.balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
        m.totalTvlForBalance += pool.tvlUsd;
      }

      // Protocol and chain TVL (use same normalizer as processPoolMetrics)
      const protocol = normalizeProtocol(pool.dexId);
      m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + pool.tvlUsd;
      m.chainTvl[chainDisplay] = (m.chainTvl[chainDisplay] ?? 0) + pool.tvlUsd;

      // Add to top pools
      m.topPools.push({
        poolId: `${pool.chain.toLowerCase()}:${pool.address.toLowerCase()}`,
        project: protocol,
        chain: chainDisplay,
        tvlUsd: pool.tvlUsd,
        symbol: pool.symbol,
        volumeUsd1d: pool.volume24hUsd,
        volumeUsd7d: pool.volume7dUsd ?? null,
        poolType: pool.poolType,
        source: pool.sourceFamily,
        ...(pool.price > 0 ? { price: pool.price } : {}),
        extra: {
          ...(hasMeasuredBalance ? {
            balanceRatio: Math.round(balanceRatio * 100) / 100,
            balanceDetails: pool.balanceDetails,
          } : {}),
          ...(pool.feeTierBps != null ? { feeTier: pool.feeTierBps } : {}),
          qualityAdjustedTvl: Math.round(qualityAdjustedTvl),
          effectiveTvl: Math.round(poolEffTvl),
          organicFraction,
          hasMeasuredOrganicFraction: false,
          pairQuality: Math.round(coinPairQuality * 100) / 100,
          stressIndex: stressIdx,
          maturityDays: pool.maturityDays,
        },
      });

      merged++;
    }
  }

  if (merged > 0) {
    console.log(`[dex-liquidity] Merged ${merged} GT pools into ${gtNewPools.size} stablecoins`);
  }
}
