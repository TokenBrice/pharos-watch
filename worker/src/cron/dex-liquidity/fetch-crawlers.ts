import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT } from "../../lib/constants";
import {
  onchainRateLimit,
  fetchCgTokenPools, parseCgPoolVolume,
} from "../../lib/coingecko-onchain";
import { GT_CHAIN_REVERSE } from "../../lib/chain-registry";
import { RATE_LIMITS, CRAWL_BUDGETS } from "../../lib/rate-limits";
import { GT_API_BASE, QUALITY_MULTIPLIERS, BLOCKED_DEX_IDS } from "../../lib/dex-constants";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import type {
  LiquidityMetrics, DexPriceObs, GtPool,
  GtCrawlResult, GtNewPool, CgNewPool,
} from "./types";
import {
  normalizeProtocol, getActiveChainReverse, getGtDexQuality,
  computePoolPairQuality, computePoolStress, initMetrics,
} from "./pool-helpers";
import { buildChainAddresses } from "./fetch-primary";
import { isPlausibleDexObservationPrice } from "./price-sanity";

/** Crawl CG onchain pools for all tracked stablecoins.
 *  No time budget needed — CG paid API is ~8x faster than GT free. */
export async function fetchCgPools(
  addressToId: Map<string, string>,
  knownPoolAddrs: Set<string>,
  protocolTvlCaps: Map<string, number>,
  signal?: AbortSignal,
): Promise<{ newPools: Map<string, CgNewPool[]>; priceObs: Map<string, DexPriceObs[]>; stats: GtCrawlResult["stats"] }> {
  const newPools = new Map<string, CgNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const stats = { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0, poolsSkippedRatio: 0 };
  const chainAddresses = buildChainAddresses();
  const nowSec = Date.now() / 1000;

  // Flatten into single list — no shuffle needed (complete coverage every cycle)
  const allTokens: { cgChain: string; ourChain: string; address: string; stablecoinId: string }[] = [];
  for (const [cgChain, tokens] of chainAddresses) {
    const ourChain = getActiveChainReverse()[cgChain] ?? cgChain;
    for (const { address, stablecoinId } of tokens) {
      allTokens.push({ cgChain, ourChain, address, stablecoinId });
    }
  }

  for (const { cgChain, ourChain, address, stablecoinId } of allTokens) {
    throwIfAborted(signal);
    await onchainRateLimit(stats.requests, signal);
    stats.requests++;

    try {
      const pools = await fetchCgTokenPools(cgChain, address, signal);
      for (const pool of pools) {
        stats.poolsSeen++;
        const a = pool.attributes;
        const dexId = pool.relationships.dex.data.id;
        const poolAddr = a.address.toLowerCase();
        const tvl = parseFloat(a.reserve_in_usd ?? "");
        if (!tvl || tvl < 10_000 || tvl > 1e12) continue;
        if (BLOCKED_DEX_IDS.has(dexId)) continue;

        // Skip Curve pools (already covered by Curve API with richer data)
        if (dexId.startsWith("curve")) {
          stats.poolsSkippedCurve++;
          continue;
        }

        // Resolve which token is our stablecoin
        const baseAddr = pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "";
        const quoteAddr = pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "";
        const addressLower = address.toLowerCase();
        let isBase = baseAddr === addressLower;
        let isQuote = quoteAddr === addressLower;
        if (!isBase && !isQuote) {
          const baseId = addressToId.get(baseAddr);
          const quoteId = addressToId.get(quoteAddr);
          if (baseId === stablecoinId) isBase = true;
          else if (quoteId === stablecoinId) isQuote = true;
          else continue;
        }

        // Extract price
        const priceStr = isBase ? a.base_token_price_usd : a.quote_token_price_usd;
        const price = parseFloat(priceStr ?? "");

        // Price observation (from ALL non-Curve pools, even known ones)
        if (isPlausibleDexObservationPrice(stablecoinId, price) && tvl >= 50_000) {
          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: ourChain, protocol: dexId });
          priceObs.set(stablecoinId, obs);
        }

        // Skip known pools for TVL/volume accounting (address match OR token-pair fingerprint)
        const poolKey = `${ourChain}:${poolAddr}`;
        const sortedTokens = [baseAddr, quoteAddr].sort().join(":");
        const fpKey = `fp:${ourChain}:${normalizeProtocol(dexId)}:${sortedTokens}`;
        if (knownPoolAddrs.has(poolKey) || knownPoolAddrs.has(fpKey)) {
          stats.poolsSkippedKnown++;
          continue;
        }

        // Volume + sanity check
        const vol24h = parseCgPoolVolume(a);
        if (tvl > 0 && vol24h / tvl > 50) {
          stats.poolsSkippedRatio++;
          continue;
        }

        // Per-pool TVL sanity cap: CG/GT concentrated liquidity pools can report
        // virtual reserves (e.g. $4.6B for a single Raydium CLMM pool). Cap individual
        // pool TVL at the protocol's total DL TVL — no single pool can exceed its protocol.
        const protoNorm = normalizeProtocol(dexId);
        const protoCap = protocolTvlCaps.get(protoNorm);
        const cappedTvl = protoCap != null && tvl > protoCap ? protoCap : tvl;

        // Quality multiplier (use fee percentage if available, else DEX-based)
        const feePct = a.pool_fee_percentage != null ? parseFloat(a.pool_fee_percentage) : null;
        let qualMult: number;
        let poolType: string;
        if (feePct != null && !isNaN(feePct)) {
          // Fee-based classification (works for any concentrated liquidity DEX)
          if (feePct <= 0.01) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-1bp"]!; poolType = "cg-cl-1bp"; }
          else if (feePct <= 0.05) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-5bp"]!; poolType = "cg-cl-5bp"; }
          else if (feePct <= 0.30) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-30bp"]!; poolType = "cg-cl-30bp"; }
          else { qualMult = QUALITY_MULTIPLIERS["generic"]!; poolType = "cg-wide-fee"; }
        } else {
          qualMult = getGtDexQuality(dexId);
          poolType = dexId.includes("v3") || dexId.includes("v4")
            ? "cg-concentrated" : dexId.includes("stable") ? "cg-stable-amm" : "cg-amm";
        }

        // Balance ratio from token prices (NEW — not available in GT)
        let balanceRatio: number | null = null;
        const basePriceUsd = parseFloat(a.base_token_price_usd ?? "");
        const quotePriceUsd = parseFloat(a.quote_token_price_usd ?? "");
        if (basePriceUsd > 0 && quotePriceUsd > 0) {
          const priceRatio = Math.min(basePriceUsd, quotePriceUsd) / Math.max(basePriceUsd, quotePriceUsd);
          if (priceRatio > 0.5) { // Only meaningful for stable-ish pairs
            balanceRatio = priceRatio;
          }
        }

        // Locked liquidity (NEW — not available in GT)
        const lockedLiqPct = a.locked_liquidity_percentage != null
          ? parseFloat(a.locked_liquidity_percentage)
          : null;

        // Maturity
        let maturityDays = 0;
        if (a.pool_created_at) {
          const createdSec = new Date(a.pool_created_at).getTime() / 1000;
          if (createdSec > 0) maturityDays = Math.floor((nowSec - createdSec) / 86400);
        }

        const poolList = newPools.get(stablecoinId) ?? [];
        poolList.push({
          address: poolAddr,
          chain: ourChain,
          dexId,
          name: a.name,
          tvlUsd: cappedTvl,
          volume24hUsd: vol24h,
          qualityMultiplier: qualMult,
          maturityDays,
          poolType,
          price,
          symbol: a.name,
          balanceRatio,
          lockedLiquidityPct: lockedLiqPct != null && !isNaN(lockedLiqPct) ? lockedLiqPct : null,
          feePercentage: feePct != null && !isNaN(feePct) ? feePct : null,
        });
        newPools.set(stablecoinId, poolList);
        stats.poolsNew++;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[dex-liquidity] CG pool crawl error for ${ourChain}:${address}:`, err);
    }
  }

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
      const balanceRatio = pool.balanceRatio ?? 1.0;
      const balanceHealth = Math.pow(balanceRatio, 1.5);
      const organicFraction = 0.5; // neutral default (no APY data from CG)
      const coinPairQuality = computePoolPairQuality(
        pool.symbol.split(/\s*\/\s*/).map((s) => s.trim()),
        meta.symbol,
      );
      const combinedQuality = pool.qualityMultiplier * balanceHealth * coinPairQuality;
      const poolEffTvl = pool.tvlUsd * combinedQuality;
      const stressIdx = computePoolStress(balanceRatio, organicFraction, pool.maturityDays, coinPairQuality);

      m.totalTvlUsd += pool.tvlUsd;
      m.totalVolume24hUsd += pool.volume24hUsd;
      m.poolCount++;
      m.chains.add(pool.chain);
      m.pairs.add(pool.symbol);
      m.qualityAdjustedTvl += pool.tvlUsd * pool.qualityMultiplier * balanceHealth;
      m.effectiveTvl += poolEffTvl;
      m.stressWeightedSum += pool.tvlUsd * stressIdx;
      m.oldestPoolDays = Math.max(m.oldestPoolDays, pool.maturityDays);

      // Locked liquidity tracking (CG pools only)
      if (pool.lockedLiquidityPct != null && pool.lockedLiquidityPct > 0) {
        m.lockedLiqWeightedSum += pool.tvlUsd * (pool.lockedLiquidityPct / 100);
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
        poolType: pool.poolType,
        source: "cg",
        extra: {
          ...(pool.balanceRatio != null ? { balanceRatio: Math.round(pool.balanceRatio * 100) / 100 } : {}),
          ...(pool.feePercentage != null ? { feeTier: Math.round(pool.feePercentage * 10000) } : {}),
          effectiveTvl: Math.round(poolEffTvl),
          organicFraction,
          pairQuality: Math.round(coinPairQuality * 100) / 100,
          stressIndex: stressIdx,
          maturityDays: pool.maturityDays,
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
): Promise<GtCrawlResult> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const stats = { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0, poolsSkippedRatio: 0 };
  const chainAddresses = buildChainAddresses();
  const nowSec = Date.now() / 1000;
  const startMs = Date.now();

  // Flatten into a single list and shuffle so coverage rotates across runs
  // (time budget means we can't always finish all 252 token-chain combos)
  const allTokens: { gtChain: string; ourChain: string; address: string; stablecoinId: string }[] = [];
  for (const [gtChain, tokens] of chainAddresses) {
    const ourChain = GT_CHAIN_REVERSE[gtChain] ?? gtChain;
    for (const { address, stablecoinId } of tokens) {
      allTokens.push({ gtChain, ourChain, address, stablecoinId });
    }
  }
  // Fisher-Yates shuffle
  for (let i = allTokens.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allTokens[i], allTokens[j]] = [allTokens[j], allTokens[i]];
  }

  for (const { gtChain, ourChain, address, stablecoinId } of allTokens) {
    throwIfAborted(signal);
    // Time budget check — stop crawling to leave time for scoring + DB writes
    if (Date.now() - startMs > CRAWL_BUDGETS.GECKO_TERMINAL_MS) {
      console.log(
        `[dex-liquidity] GT pool crawl time budget exhausted after ${stats.requests}/${allTokens.length} requests ` +
        `(${Math.round((Date.now() - startMs) / 1000)}s), yielding partial results`
      );
      return { newPools, priceObs, stats };
    }

    if (stats.requests > 0) {
      await sleepWithSignal(RATE_LIMITS.GECKO_TERMINAL_MS, signal);
    }
    stats.requests++;

    try {
      // maxRetries=0: single attempt per request to keep wall time predictable.
      // fetchWithRetry's internal 429 handling (5s+ delays) would make total time unbounded.
      const url = `${GT_API_BASE}/networks/${gtChain}/tokens/${address}/pools?page=1`;
      const res = await fetchWithRetry(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal,
      }, 0);
      if (!res?.ok) continue;

        const json = (await res.json()) as { data?: GtPool[] };
        if (!json.data) continue;

        for (const pool of json.data) {
          stats.poolsSeen++;
          const a = pool.attributes;
          const dexId = pool.relationships.dex.data.id;
          const poolAddr = a.address.toLowerCase();
          const tvl = parseFloat(a.reserve_in_usd ?? "");
          if (!tvl || tvl < 10_000 || tvl > 1e12) continue; // Skip dust and corrupt values
          if (BLOCKED_DEX_IDS.has(dexId)) continue;

          // Rule 1: Skip Curve pools entirely
          if (dexId.startsWith("curve")) {
            stats.poolsSkippedCurve++;
            continue;
          }

          // Resolve which token in this pool is our stablecoin
          // GT pool relationship IDs are formatted as "{network}_{address}"
          const baseAddr = pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "";
          const quoteAddr = pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "";
          const addressLower = address.toLowerCase();
          let isBase = baseAddr === addressLower;
          let isQuote = quoteAddr === addressLower;
          if (!isBase && !isQuote) {
            // Neither token matches directly — try addressToId fallback
            const baseId = addressToId.get(baseAddr);
            const quoteId = addressToId.get(quoteAddr);
            if (baseId === stablecoinId) isBase = true;
            else if (quoteId === stablecoinId) isQuote = true;
            else continue;
          }

          // Extract price for our stablecoin (use the side we resolved)
          const priceStr = isBase ? a.base_token_price_usd : a.quote_token_price_usd;
          const price = parseFloat(priceStr ?? "");

          // Price observation (from ALL non-Curve pools, even known ones)
          if (isPlausibleDexObservationPrice(stablecoinId, price) && tvl >= 50_000) {
            const obs = priceObs.get(stablecoinId) ?? [];
            obs.push({ price, tvl, chain: ourChain, protocol: dexId });
            priceObs.set(stablecoinId, obs);
          }

          // Rule 2: Skip TVL/volume for known pools (address match OR token-pair fingerprint)
          const poolKey = `${ourChain}:${poolAddr}`;
          const sortedTokens = [baseAddr, quoteAddr].sort().join(":");
          const fpKey = `fp:${ourChain}:${normalizeProtocol(dexId)}:${sortedTokens}`;
          if (knownPoolAddrs.has(poolKey) || knownPoolAddrs.has(fpKey)) {
            stats.poolsSkippedKnown++;
            continue;
          }

          // Rule 3: New pool — add with GT quality
          const vol24h = parseFloat(a.volume_usd?.h24 ?? "0");

          // Sanity check: volume/TVL ratio > 50x is garbage data
          // (legit concentrated AMMs like Maverick hit 15-25x)
          if (tvl > 0 && vol24h / tvl > 50) {
            stats.poolsSkippedRatio++;
            continue;
          }

          // Per-pool TVL sanity cap (see fetchCgPools for rationale)
          const protoNorm = normalizeProtocol(dexId);
          const protoCap = protocolTvlCaps.get(protoNorm);
          const cappedTvl = protoCap != null && tvl > protoCap ? protoCap : tvl;

          const qualMult = getGtDexQuality(dexId);

          let maturityDays = 0;
          if (a.pool_created_at) {
            const createdSec = new Date(a.pool_created_at).getTime() / 1000;
            if (createdSec > 0) {
              maturityDays = Math.floor((nowSec - createdSec) / 86400);
            }
          }

          // Classify pool type for display
          const poolType = dexId.includes("v3") || dexId.includes("v4")
            ? "concentrated" : dexId.includes("stable") ? "stable-amm" : "amm";

          const pools = newPools.get(stablecoinId) ?? [];
          pools.push({
            address: poolAddr,
            chain: ourChain,
            dexId,
            name: a.name,
            tvlUsd: cappedTvl,
            volume24hUsd: vol24h,
            qualityMultiplier: qualMult,
            maturityDays,
            poolType: `gt-${poolType}`,
            price,
            symbol: a.name, // GT pool name is like "USDC / USDT"
          });
          newPools.set(stablecoinId, pools);
          stats.poolsNew++;
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[dex-liquidity] GT pool crawl error for ${ourChain}:${address}:`, err);
      }
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
      const organicFraction = 0.5; // neutral default for GT pools
      const balanceRatio = 1.0;    // no balance data from GT
      // Note: GT pools intentionally excluded from balanceRatioWeightedSum and
      // organicTvlWeightedSum to avoid diluting those signals with neutral defaults.
      // Only Curve (balance) and DeFiLlama-APY (organic) pools contribute real data.
      const coinPairQuality = computePoolPairQuality(
        pool.symbol.split(/\s*\/\s*/).map((s) => s.trim()),
        meta.symbol,
      );
      const combinedQuality = pool.qualityMultiplier * coinPairQuality;
      const poolEffTvl = pool.tvlUsd * combinedQuality;
      const stressIdx = computePoolStress(balanceRatio, organicFraction, pool.maturityDays, coinPairQuality);

      m.totalTvlUsd += pool.tvlUsd;
      m.totalVolume24hUsd += pool.volume24hUsd;
      m.poolCount++;
      m.chains.add(pool.chain);
      m.pairs.add(pool.symbol);
      m.qualityAdjustedTvl += pool.tvlUsd * pool.qualityMultiplier;
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
        poolType: pool.poolType,
        source: "gt",
        extra: {
          effectiveTvl: Math.round(poolEffTvl),
          organicFraction,
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
