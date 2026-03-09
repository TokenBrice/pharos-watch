import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { STAGED_POOL_DEFAULTS } from "../dex-discovery/types";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT } from "../../lib/constants";
import {
  onchainRateLimit, fetchCgTokenPools, parseCgPoolVolume, CG_CHAIN_MAP,
} from "../../lib/coingecko-onchain";
import { GT_CHAIN_MAP } from "../../lib/chain-registry";
import { RATE_LIMITS, CRAWL_BUDGETS } from "../../lib/rate-limit";
import { GT_API_BASE, QUALITY_MULTIPLIERS } from "../../lib/dex-constants";
import { sleepWithSignal } from "../../lib/abort";
import type {
  LiquidityMetrics, DexPriceObs, GtPool,
  GtCrawlResult, GtNewPool, CgNewPool,
} from "./types";
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
  addressToId: Map<string, string>,
  knownPoolAddrs: Set<string>,
  protocolTvlCaps: Map<string, number>,
  signal?: AbortSignal,
  chainAddresses: Map<string, ProviderChainAddress[]> = buildChainAddresses(CG_CHAIN_MAP),
  deadlineMs?: number,
): Promise<{ newPools: Map<string, CgNewPool[]>; priceObs: Map<string, DexPriceObs[]>; stats: GtCrawlResult["stats"] }> {
  const newPools = new Map<string, CgNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const stats: CrawlStats = { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0, poolsSkippedRatio: 0 };
  const allTokens = buildCrawlTokens(chainAddresses);

  await crawlTokenPools({
    sourceLabel: "CG",
    tokens: allTokens,
    addressToId,
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
    fetchPools: (tokenAddress, cgChain, abortSignal) => fetchCgTokenPools(cgChain, tokenAddress, abortSignal),
    parsePool: (pool) => {
      const a = pool.attributes;
      return {
        dexId: pool.relationships.dex.data.id,
        poolAddress: a.address.toLowerCase(),
        tvlUsd: parseFloat(a.reserve_in_usd ?? ""),
        volume24hUsd: parseCgPoolVolume(a),
        baseTokenAddress: pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "",
        quoteTokenAddress: pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "",
        baseTokenPriceUsd: parseFloat(a.base_token_price_usd ?? ""),
        quoteTokenPriceUsd: parseFloat(a.quote_token_price_usd ?? ""),
        createdAt: a.pool_created_at,
        poolName: a.name,
      };
    },
    buildNewPool: ({ rawPool, parsed, chain, price, cappedTvlUsd, maturityDays }) => {
      const attrs = rawPool.attributes;

      // Quality multiplier (use fee percentage if available, else DEX-based)
      const feePct = attrs.pool_fee_percentage != null ? parseFloat(attrs.pool_fee_percentage) : null;
      let qualMult: number;
      let poolType: string;
      if (feePct != null && !isNaN(feePct)) {
        if (feePct <= 0.01) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-1bp"]!; poolType = "cg-cl-1bp"; }
        else if (feePct <= 0.05) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-5bp"]!; poolType = "cg-cl-5bp"; }
        else if (feePct <= 0.30) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-30bp"]!; poolType = "cg-cl-30bp"; }
        else { qualMult = QUALITY_MULTIPLIERS["generic"]!; poolType = "cg-wide-fee"; }
      } else {
        qualMult = getGtDexQuality(parsed.dexId);
        poolType = parsed.dexId.includes("v3") || parsed.dexId.includes("v4")
          ? "cg-concentrated" : parsed.dexId.includes("stable") ? "cg-stable-amm" : "cg-amm";
      }

      let balanceRatio: number | null = null;
      if (parsed.baseTokenPriceUsd > 0 && parsed.quoteTokenPriceUsd > 0) {
        const priceRatio = Math.min(parsed.baseTokenPriceUsd, parsed.quoteTokenPriceUsd) /
          Math.max(parsed.baseTokenPriceUsd, parsed.quoteTokenPriceUsd);
        if (priceRatio > 0.5) {
          balanceRatio = priceRatio;
        }
      }

      const lockedLiqPct = attrs.locked_liquidity_percentage != null
        ? parseFloat(attrs.locked_liquidity_percentage)
        : null;

      return {
        address: parsed.poolAddress,
        chain,
        dexId: parsed.dexId,
        name: parsed.poolName,
        tvlUsd: cappedTvlUsd,
        volume24hUsd: parsed.volume24hUsd,
        qualityMultiplier: qualMult,
        maturityDays,
        poolType,
        price,
        symbol: parsed.poolName,
        balanceRatio,
        lockedLiquidityPct: lockedLiqPct != null && !isNaN(lockedLiqPct) ? lockedLiqPct : null,
        feePercentage: feePct != null && !isNaN(feePct) ? feePct : null,
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
    const meta = TRACKED_STABLECOINS.find((s) => s.id === stablecoinId);
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
        pool.symbol.split(/\s*\/\s*/).map((s) => s.trim()),
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
        source: "cg",
        extra: {
          ...(pool.balanceRatio != null ? { balanceRatio: Math.round(pool.balanceRatio * 100) / 100 } : {}),
          ...(pool.feePercentage != null ? { feeTier: Math.round(pool.feePercentage * 10000) } : {}),
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
  addressToId: Map<string, string>,
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
    addressToId,
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
    fetchPools: async (tokenAddress, gtChain, abortSignal) => {
      // maxRetries=0: single attempt per request to keep wall time predictable.
      // fetchWithRetry's internal 429 handling (5s+ delays) would make total time unbounded.
      const url = `${GT_API_BASE}/networks/${gtChain}/tokens/${tokenAddress}/pools?page=1`;
      const res = await fetchWithRetry(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: abortSignal,
      }, 0);
      if (!res?.ok) return [];
      const json = (await res.json()) as { data?: GtPool[] };
      return json.data ?? [];
    },
    parsePool: (pool) => {
      const a = pool.attributes;
      return {
        dexId: pool.relationships.dex.data.id,
        poolAddress: a.address.toLowerCase(),
        tvlUsd: parseFloat(a.reserve_in_usd ?? ""),
        volume24hUsd: parseFloat(a.volume_usd?.h24 ?? "0"),
        baseTokenAddress: pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "",
        quoteTokenAddress: pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "",
        baseTokenPriceUsd: parseFloat(a.base_token_price_usd ?? ""),
        quoteTokenPriceUsd: parseFloat(a.quote_token_price_usd ?? ""),
        createdAt: a.pool_created_at,
        poolName: a.name,
      };
    },
    buildNewPool: ({ parsed, chain, price, cappedTvlUsd, maturityDays }) => {
      const poolType = parsed.dexId.includes("v3") || parsed.dexId.includes("v4")
        ? "concentrated" : parsed.dexId.includes("stable") ? "stable-amm" : "amm";
      return {
        address: parsed.poolAddress,
        chain,
        dexId: parsed.dexId,
        name: parsed.poolName,
        tvlUsd: cappedTvlUsd,
        volume24hUsd: parsed.volume24hUsd,
        qualityMultiplier: getGtDexQuality(parsed.dexId),
        maturityDays,
        poolType: `gt-${poolType}`,
        price,
        symbol: parsed.poolName,
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
    const meta = TRACKED_STABLECOINS.find((s) => s.id === stablecoinId);
    if (!meta) continue;

    let m = metrics.get(stablecoinId);
    if (!m) {
      m = initMetrics(stablecoinId, meta.symbol);
      metrics.set(stablecoinId, m);
    }

    for (const pool of pools) {
      const organicFraction = STAGED_POOL_DEFAULTS.organicFraction;
      const balanceRatio = STAGED_POOL_DEFAULTS.balanceRatioFallback;
      // Note: GT pools intentionally excluded from balanceRatioWeightedSum and
      // organicTvlWeightedSum to avoid diluting those signals with neutral defaults.
      // Only Curve (balance) and DeFiLlama-APY (organic) pools contribute real data.
      const coinPairQuality = computePoolPairQuality(
        pool.symbol.split(/\s*\/\s*/).map((s) => s.trim()),
        meta.symbol,
      );
      const combinedQuality = pool.qualityMultiplier * coinPairQuality;
      const qualityAdjustedTvl = pool.tvlUsd * pool.qualityMultiplier;
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

      // Protocol and chain TVL (use same normalizer as processPoolMetrics)
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
        source: "gt",
        extra: {
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
