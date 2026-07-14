import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/lib/exit-route-identity";
import { QUALITY_MULTIPLIERS, isBlockedDexId } from "../../lib/dex-cron-constants";
import type { LlamaPool, CurvePoolEntry, LiquidityMetrics } from "./types";
import {
  classifyPoolType,
  buildPoolFingerprint,
  getQualityMultiplier,
  normalizeProtocol,
  computePoolPairQuality,
  computePoolQualityContribution,
  computePoolStress,
  initMetrics,
  isCryptoSwap,
} from "./pool-helpers";
import { isTrustworthyExactPoolId } from "./pool-identity";
import { resolveLlamaPoolStablecoinMatches } from "./pool-match-resolution";
import type { DexAmmExecutionModel } from "@shared/types/market";

/**
 * The Curve pools endpoint does not publish per-pool fees. Standard
 * stableswap pools charge 1-4 bps; the model carries this conservative
 * upper bound so simulated output understates rather than overstates
 * execution, keeping the capacity result an exact lower bound.
 */
const CURVE_STABLESWAP_FEE_BOUND = 0.001;

/**
 * Builds the exact StableSwap execution model for an address-matched plain
 * Curve pool whose complete per-coin capture survived shaping. Returns null
 * whenever any identity, balance, or tracked-token requirement fails.
 */
export function buildCurveStableswapExecutionModel(
  curveData: CurvePoolEntry | undefined,
  chainNorm: string,
  stablecoinId: string,
  chainAddressToId: Map<string, string>,
): DexAmmExecutionModel | null {
  const coins = curveData?.executionCoins;
  if (!coins || curveData.isMetaPool || !Number.isFinite(curveData.A) || curveData.A <= 0) return null;
  const tokens = coins.map((coin) => {
    const trackedAssetId = chainAddressToId.get(`${chainNorm}:${coin.address.toLowerCase()}`);
    return {
      address: coin.address,
      symbol: coin.symbol,
      decimals: coin.decimals,
      balance: coin.balance,
      referencePriceUsd: coin.usdPrice,
      referencePriceSource: "source-token-usd" as const,
      ...(trackedAssetId ? { trackedAssetId } : {}),
    };
  });
  const trackedTokenIndex = tokens.findIndex((token) => token.trackedAssetId === stablecoinId);
  if (trackedTokenIndex === -1) return null;
  const addresses = tokens.map((token) => `${chainNorm}:${token.address.toLowerCase()}`);
  if (new Set(addresses).size !== addresses.length) return null;
  return {
    source: "curve",
    invariant: "stableswap",
    trackedTokenIndex,
    feeRate: CURVE_STABLESWAP_FEE_BOUND,
    amplification: curveData.A,
    tokens,
  };
}

/** Match DeFiLlama pools to tracked stablecoins and compute per-pool metrics. */
export function processPoolMetrics(
  pools: LlamaPool[],
  dexProjects: Set<string>,
  symbolToIds: Map<string, string[]>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  addressToId: Map<string, string>,
  chainAddressToId: Map<string, string>,
  curvePoolMap: Map<string, CurvePoolEntry>,
  uniV3PoolFees: Map<string, number>,
  uniV3SymbolFees: Map<string, number>,
  aerodromeIsStable: Map<string, boolean>,
): Map<string, LiquidityMetrics> {
  const metrics = new Map<string, LiquidityMetrics>();
  const enforceDexProjectFilter = dexProjects.size > 0;
  if (!enforceDexProjectFilter) {
    console.warn("[dex-liquidity] DEX project index is empty — project whitelist filter disabled for this run");
  }

  for (const pool of pools) {
    try {
      if (!pool.tvlUsd || pool.tvlUsd < 10_000 || pool.tvlUsd > 1e12) continue; // Skip dust and corrupt values
      if (enforceDexProjectFilter && !dexProjects.has(pool.project)) continue; // Only count DEX pools
      if (isBlockedDexId(pool.project)) continue; // Skip explicitly blocked dead DEXes
      // v2: skip lending pools (single-asset exposure, not DEX liquidity)
      if (pool.exposure === "single") continue;

      const { matchedIds, poolSymbols } = resolveLlamaPoolStablecoinMatches(pool, {
        chainAddressToId,
        symbolToChainScopedIds,
      });

      if (matchedIds.size === 0) continue;

      const poolType = classifyPoolType(pool.project);
      const protocol = normalizeProtocol(pool.project);
      const vol1d = pool.volumeUsd1d ?? 0;
      const vol7d = pool.volumeUsd7d ?? 0;

      // Try to find Curve enrichment data (address-based first, symbol-combo fallback)
      const chainNorm = canonicalExitRouteChain(pool.chain);
      const addrCurveKey = canonicalExitRouteAssetKey(chainNorm, pool.pool);
      const symCurveKey = `${chainNorm}:${poolSymbols
        .map((s) => s.toUpperCase())
        .sort()
        .join("-")}`;
      const curveData =
        protocol === "curve" ? (curvePoolMap.get(addrCurveKey) ?? curvePoolMap.get(symCurveKey)) : undefined;
      // Track whether the match was address-based: metapoolAdjustedTvl is only valid for
      // the specific Curve pool whose address matched. Symbol fallbacks may hit a different
      // physical pool sharing the same token pair, so we preserve their own TVL.
      const curveAddressMatch = curvePoolMap.has(addrCurveKey);

      // --- v2: Enhanced quality resolution ---
      let qualMult: number;
      let resolvedPoolType = poolType;
      let feeTierForExtra: number | undefined;
      let balanceRatio = 1;
      let poolMaturityDays = 0;
      let organicFraction = 0.5; // neutral default
      let hasMeasuredOrganicFraction = false;
      let effectivePoolTvl = pool.tvlUsd;
      let balanceDetails: { symbol: string; balancePct: number; isTracked: boolean }[] | undefined;

      if (curveData) {
        balanceRatio = curveData.balanceRatio;
        balanceDetails = curveData.balanceDetails;
        // v2: CryptoSwap vs StableSwap
        if (isCryptoSwap(curveData.registryId)) {
          resolvedPoolType = "curve-cryptoswap";
          qualMult = QUALITY_MULTIPLIERS["curve-cryptoswap"]!;
        } else {
          resolvedPoolType = curveData.A >= 500 ? "curve-stableswap-high-a" : "curve-stableswap";
          qualMult = getQualityMultiplier(resolvedPoolType, curveData.A);
        }
        // Use metapool-adjusted TVL only for address-based matches (the actual Curve pool).
        // Symbol fallbacks may match a different physical pool sharing the same token pair —
        // those pools must use their own TVL, not the Curve pool's.
        effectivePoolTvl = curveAddressMatch ? curveData.metapoolAdjustedTvl : pool.tvlUsd;
        // Use the same adjusted TVL for raw totals so metapool double-counting is removed
        // from totalTvlUsd, protocolTvl, chainTvl, and per-pool tvlUsd.
        // Pool maturity from Curve creation timestamp
        if (curveData.creationTs > 0) {
          poolMaturityDays = Math.floor((Date.now() / 1000 - curveData.creationTs) / DAY_SECONDS);
        }
      } else if (poolType === "uniswap-v3-5bp" && uniV3PoolFees.size > 0) {
        // Try to resolve exact fee tier from subgraph data
        const addrKey = canonicalExitRouteAssetKey(chainNorm, pool.pool);
        let feeTier = uniV3PoolFees.get(addrKey);
        if (feeTier == null) {
          const symKey = `${chainNorm}:${poolSymbols
            .map((s) => s.toUpperCase())
            .sort()
            .join(":")}`;
          feeTier = uniV3SymbolFees.get(symKey);
        }
        if (feeTier != null) {
          feeTierForExtra = feeTier;
          if (feeTier <= 100) resolvedPoolType = "uniswap-v3-1bp";
          else if (feeTier <= 500) resolvedPoolType = "uniswap-v3-5bp";
          else resolvedPoolType = "uniswap-v3-30bp";
        }
        qualMult = getQualityMultiplier(resolvedPoolType);
      } else if (poolType === "aerodrome-volatile" && aerodromeIsStable.size > 0) {
        // Refine Aerodrome pool type using isStable flag from subgraph
        const addrKey = canonicalExitRouteAssetKey(chainNorm, pool.pool);
        const isStable = aerodromeIsStable.get(addrKey);
        if (isStable === true) {
          resolvedPoolType = "aerodrome-stable";
        }
        qualMult = getQualityMultiplier(resolvedPoolType);
      } else {
        qualMult = getQualityMultiplier(poolType);
      }

      // Organic fraction from DeFiLlama APY data
      // Guard against NaN/Infinity from upstream data to prevent score corruption (H-1)
      if (
        pool.apyBase != null &&
        Number.isFinite(pool.apyBase) &&
        pool.apy != null &&
        Number.isFinite(pool.apy) &&
        pool.apy > 0.01
      ) {
        organicFraction = Math.min(1, Math.max(0, pool.apyBase / pool.apy));
        hasMeasuredOrganicFraction = true;
      } else if (pool.apyBase != null && Number.isFinite(pool.apyBase)) {
        organicFraction = pool.apyBase > 0 ? 1.0 : 0;
        hasMeasuredOrganicFraction = true;
      }

      // Pool maturity from DeFiLlama count (fallback for non-Curve)
      if (poolMaturityDays === 0 && pool.count > 0) {
        poolMaturityDays = pool.count; // ~1 data point per day
      }

      // For Curve metapools matched by address, use the adjusted TVL that strips
      // double-counted underlying-pool value from all raw aggregates.
      const rawContribTvl = curveAddressMatch ? curveData!.metapoolAdjustedTvl : pool.tvlUsd;

      for (const id of matchedIds) {
        const meta = TRACKED_META_BY_ID.get(id);
        if (!meta) continue;

        let m = metrics.get(id);
        if (!m) {
          m = initMetrics(id, meta.symbol);
          metrics.set(id, m);
        }

        // Per-stablecoin pair quality
        const coinPairQuality = computePoolPairQuality(poolSymbols, meta.symbol);

        const { qualityAdjustedTvl: poolQualityAdjustedTvl, effectiveTvl: poolEffTvl } = computePoolQualityContribution(
          {
            qualityTvlUsd: pool.tvlUsd,
            effectiveTvlUsd: effectivePoolTvl,
            qualityMultiplier: qualMult,
            balanceRatio,
            pairQuality: coinPairQuality,
            hasMeasuredBalance: curveData != null,
          },
        );

        // Pool stress for this pool
        const stressIdx = computePoolStress(balanceRatio, organicFraction, poolMaturityDays, coinPairQuality);

        m.totalTvlUsd += rawContribTvl;
        m.totalVolume24hUsd += vol1d;
        m.totalVolume7dUsd += vol7d;
        m.poolCount++;
        m.chains.add(pool.chain);
        m.pairs.add(pool.symbol);
        m.qualityAdjustedTvl += poolQualityAdjustedTvl;
        m.effectiveTvl += poolEffTvl;

        // Weighted balance ratio tracking (Curve pools only)
        if (curveData) {
          m.balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
          m.totalTvlForBalance += pool.tvlUsd;
        }

        // Weighted organic fraction tracking
        if (hasMeasuredOrganicFraction) {
          m.organicTvlWeightedSum += pool.tvlUsd * organicFraction;
          m.totalTvlForOrganic += pool.tvlUsd;
        }

        // Stress tracking (TVL-weighted)
        m.stressWeightedSum += pool.tvlUsd * stressIdx;

        // Track oldest pool
        m.oldestPoolDays = Math.max(m.oldestPoolDays, poolMaturityDays);

        // Protocol and chain TVL
        m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + rawContribTvl;
        m.chainTvl[pool.chain] = (m.chainTvl[pool.chain] ?? 0) + rawContribTvl;

        // Pool-level price: use Curve per-token price when available
        const poolPrice = curveData?.tokenPrices[meta.symbol.toUpperCase()];

        // Exact stableswap execution model: address-matched plain Curve pools
        // whose complete per-coin inputs survived capture. The fee is not
        // published by the pools endpoint, so the model carries a documented
        // conservative bound and the capacity result is an exact lower bound.
        const ammExecutionModel = buildCurveStableswapExecutionModel(
          curveAddressMatch ? curveData : undefined,
          chainNorm,
          id,
          chainAddressToId,
        );

        // Pool entry with enriched extra
        m.topPools.push({
          poolId: isTrustworthyExactPoolId(pool.pool, pool.project)
            ? canonicalExitRouteAssetKey(pool.chain, pool.pool)
            : (buildPoolFingerprint(chainNorm, pool.project, pool.underlyingTokens ?? []) ??
              canonicalExitRouteAssetKey(pool.chain, pool.pool)),
          project: protocol,
          chain: pool.chain,
          tvlUsd: rawContribTvl,
          symbol: pool.symbol,
          volumeUsd1d: vol1d,
          volumeUsd7d: vol7d,
          poolType: resolvedPoolType,
          source: "dl",
          ...(poolPrice != null ? { price: poolPrice } : {}),
          extra: {
            ...(curveData
              ? {
                  amplificationCoefficient: curveData.A,
                  balanceRatio: Math.round(balanceRatio * 100) / 100,
                  registryId: curveData.registryId,
                  isMetaPool: curveData.isMetaPool,
                  balanceDetails,
                }
              : feeTierForExtra != null
                ? { feeTier: Math.round(feeTierForExtra / 100) }
                : {}),
            ...(ammExecutionModel ? { ammExecutionModel } : {}),
            qualityAdjustedTvl: Math.round(poolQualityAdjustedTvl),
            effectiveTvl: Math.round(poolEffTvl),
            organicFraction: Math.round(organicFraction * 100) / 100,
            hasMeasuredOrganicFraction,
            pairQuality: Math.round(coinPairQuality * 100) / 100,
            stressIndex: stressIdx,
            maturityDays: poolMaturityDays,
            measurement: {
              tvlMeasured: true,
              volumeMeasured: vol1d > 0 || vol7d > 0,
              balanceMeasured: curveData != null,
              maturityMeasured: poolMaturityDays > 0,
              priceMeasured: poolPrice != null && poolPrice > 0,
              synthetic: false,
            },
          },
        });
      }
    } catch (err) {
      console.error(`[dex-liquidity] Pool processing failed for pool=${pool.pool} chain=${pool.chain}:`, err);
      continue;
    }
  }

  console.log(`[dex-liquidity] Matched ${metrics.size} stablecoins with DEX liquidity`);
  return metrics;
}
