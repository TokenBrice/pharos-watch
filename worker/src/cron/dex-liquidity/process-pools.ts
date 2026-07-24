import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/lib/exit-route-identity";
import { QUALITY_MULTIPLIERS, isBlockedDexId } from "../../lib/dex-cron-constants";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { EvmV2ExecutionCandidate, LlamaPool, CurvePoolEntry, LiquidityMetrics } from "./types";
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
  parsePoolSymbols,
} from "./pool-helpers";
import { isTrustworthyExactPoolId } from "./pool-identity";
import { resolveLlamaPoolStablecoinMatches } from "./pool-match-resolution";
import type { DexAmmExecutionModel, DexExecutionCapabilityGate } from "@shared/types/market";
import {
  DEX_MEASURED_TARGET_SCHEMA_VERSION,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "./constants";
import {
  buildUniV3ExecutionCandidateKey,
  buildUniV3MeasuredExecutionTarget,
  parseUniV3FeePips,
  type UniV3ExecutionCandidate,
} from "../measured-execution/inventory";
import {
  CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  getCurveCryptoSwapShadowPolicy,
} from "../measured-execution/curve-cryptoswap";
import {
  CURVE_3POOL_STABLESWAP_POLICY,
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
} from "../measured-execution/curve-stableswap";
import { buildEvmV2ExecutionCandidate } from "./constant-product-v2";

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
/**
 * StableSwap math assumes pool units exchange near 1:1. Rate-bearing pools
 * (sUSDe, sfrxUSD, stUSDS legs) run the invariant on rate-scaled balances the
 * Curve pools endpoint does not expose; modeling them on raw balances
 * overstated on-chain get_dy by 6-24% in live probes. A persistent per-coin
 * USD price spread is the observable signature of such a pool, so any spread
 * beyond this bound fails closed to shaped TVL evidence.
 */
const CURVE_STABLESWAP_MAX_COIN_PRICE_SPREAD = 1.01;
const ACTIVE_CURVE_CRYPTOSWAP_MAX_TVL_RELATIVE_DRIFT = 0.005;

export interface CurveStableswapExecutionCapability {
  executionModel: DexAmmExecutionModel | null;
  gate: DexExecutionCapabilityGate | null;
}

export function buildCurveStableswapExecutionCapability(
  curveData: CurvePoolEntry | undefined,
  chainNorm: string,
  stablecoinId: string,
  chainAddressToId: Map<string, string>,
): CurveStableswapExecutionCapability {
  if (!curveData) {
    return {
      executionModel: null,
      gate: { family: "curve-stableswap", reason: "exact-pool-join-unresolved" },
    };
  }
  if (isCryptoSwap(curveData.registryId)) {
    return {
      executionModel: null,
      gate: { family: "curve-cryptoswap", reason: "unsupported-invariant" },
    };
  }
  if (curveData.isMetaPool) {
    return {
      executionModel: null,
      gate: { family: "curve-stableswap", reason: "metapool-unsupported" },
    };
  }
  if (!Number.isFinite(curveData.A) || curveData.A <= 0) {
    return {
      executionModel: null,
      gate: { family: "curve-stableswap", reason: "invalid-invariant-parameters" },
    };
  }
  const coins = curveData?.executionCoins;
  if (!coins || coins.length < 2) {
    return {
      executionModel: null,
      gate: { family: "curve-stableswap", reason: "incomplete-exact-capture" },
    };
  }
  const prices = coins.map((coin) => coin.usdPrice);
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || !(minPrice > 0)) {
    return {
      executionModel: null,
      gate: { family: "curve-stableswap", reason: "incomplete-exact-capture" },
    };
  }
  if (maxPrice / minPrice > CURVE_STABLESWAP_MAX_COIN_PRICE_SPREAD) {
    return {
      executionModel: null,
      gate: { family: "curve-stableswap", reason: "rate-bearing-inputs" },
    };
  }
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
  if (trackedTokenIndex === -1) {
    return {
      executionModel: null,
      gate: { family: "curve-stableswap", reason: "tracked-input-unresolved" },
    };
  }
  const addresses = tokens.map((token) => `${chainNorm}:${token.address.toLowerCase()}`);
  if (new Set(addresses).size !== addresses.length) {
    return {
      executionModel: null,
      gate: { family: "curve-stableswap", reason: "ambiguous-token-identity" },
    };
  }
  // The Curve API reports the contract amplification (Ann = A_contract * n); the
  // execution model stores the plain paper convention (Ann = A * n^n). Converting by
  // n^(n-1) reproduces on-chain get_dy exactly (verified against 3pool and the
  // crvUSD/USDC NG pool at a pinned block); passing the contract value through
  // overstates amplification and therefore exit capacity.
  const n = tokens.length;
  return {
    executionModel: {
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex,
      feeRate: CURVE_STABLESWAP_FEE_BOUND,
      amplification: curveData.A / n ** (n - 1),
      tokens,
    },
    gate: null,
  };
}

export function buildCurveStableswapExecutionModel(
  curveData: CurvePoolEntry | undefined,
  chainNorm: string,
  stablecoinId: string,
  chainAddressToId: Map<string, string>,
): DexAmmExecutionModel | null {
  return buildCurveStableswapExecutionCapability(curveData, chainNorm, stablecoinId, chainAddressToId).executionModel;
}

/** @internal Exported for focused execution-target validation. */
export function buildCurveCryptoSwapMeasuredExecutionTarget(input: {
  curveData: CurvePoolEntry | undefined;
  chain: string;
  stablecoinId: string;
  chainAddressToId: Map<string, string>;
  stablecoinPriceById?: Map<string, number>;
  retainedTvlUsd: number;
  capturedAt: number;
}): DexMeasuredExecutionTarget | null {
  const { curveData } = input;
  if (!curveData || !isCryptoSwap(curveData.registryId) || curveData.apiIsBroken) return null;
  if (!curveData.poolAddress) return null;
  const policy = getCurveCryptoSwapShadowPolicy(input.chain, curveData.poolAddress);
  if (!policy?.scoreEligible || policy.mode !== "active") return null;
  const executionCoins = curveData.executionCoins;
  if (!executionCoins || executionCoins.length !== 2) return null;
  const poolAddress = curveData.poolAddress.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(poolAddress)) return null;
  const poolTokenAddresses = executionCoins.map((coin) => coin.address.toLowerCase());
  if (poolTokenAddresses.some((address) => !/^0x[a-f0-9]{40}$/.test(address))) return null;
  const inputIndex = executionCoins.findIndex(
    (coin) => input.chainAddressToId.get(canonicalExitRouteAssetKey(input.chain, coin.address)) === input.stablecoinId,
  );
  if (inputIndex < 0) return null;
  const outputIndex = inputIndex === 0 ? 1 : 0;
  const tokenIn = executionCoins[inputIndex]!;
  const tokenOut = executionCoins[outputIndex]!;
  const inputReferencePriceUsd = input.stablecoinPriceById?.get(input.stablecoinId) ?? tokenIn.usdPrice;
  if (
    !Number.isFinite(inputReferencePriceUsd) ||
    inputReferencePriceUsd <= 0 ||
    !Number.isFinite(tokenOut.usdPrice) ||
    tokenOut.usdPrice <= 0
  )
    return null;
  const outputStablecoinId = input.chainAddressToId.get(canonicalExitRouteAssetKey(input.chain, tokenOut.address));
  if (outputStablecoinId === input.stablecoinId) return null;
  const poolId = canonicalExitRouteAssetKey(input.chain, poolAddress);
  const canonicalTokens = poolTokenAddresses as [`0x${string}`, `0x${string}`];
  const targetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
    stablecoinId: input.stablecoinId,
    chain: input.chain,
    protocol: "curve",
    poolId,
    tokenInAddress: canonicalTokens[inputIndex]!,
    tokenOutAddress: canonicalTokens[outputIndex]!,
    poolTokenAddresses: canonicalTokens,
  });
  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId,
    stablecoinId: input.stablecoinId,
    adapterProfileId: CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
    protocol: "curve",
    chain: input.chain,
    poolId,
    poolTokenAddresses: canonicalTokens,
    tokenIn: {
      address: canonicalTokens[inputIndex]!,
      symbol: tokenIn.symbol,
      decimals: tokenIn.decimals,
      referencePriceUsd: inputReferencePriceUsd,
      trackedAssetId: input.stablecoinId,
    },
    tokenOut: {
      address: canonicalTokens[outputIndex]!,
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals,
      referencePriceUsd: tokenOut.usdPrice,
      ...(outputStablecoinId ? { trackedAssetId: outputStablecoinId } : {}),
    },
    retainedTvlUsd: input.retainedTvlUsd,
    retainedPoolPriceUsd: inputReferencePriceUsd,
    capturedAt: input.capturedAt,
  };
}

const CURVE_3POOL_REVIEWED_INPUT_IDS = new Set(["usdc-circle", "usdt-tether"]);
const CURVE_3POOL_TRACKED_IDS = ["dai-makerdao", "usdc-circle", "usdt-tether"] as const;

export function resolveReviewedCurveStableSwapPhysicalPoolId(input: {
  curveData: CurvePoolEntry | undefined;
  chain: string;
}): string | null {
  const { curveData } = input;
  const policy = CURVE_3POOL_STABLESWAP_POLICY;
  if (
    input.chain !== policy.chain ||
    !curveData ||
    curveData.apiIsBroken ||
    curveData.isMetaPool ||
    curveData.registryId.trim().toLowerCase() !== "main" ||
    curveData.poolAddress?.toLowerCase() !== policy.poolAddress ||
    curveData.executionCoins?.length !== policy.poolTokens.length
  ) return null;
  for (let index = 0; index < policy.poolTokens.length; index += 1) {
    const expected = policy.poolTokens[index]!;
    const actual = curveData.executionCoins[index]!;
    if (
      actual.address.toLowerCase() !== expected.address ||
      actual.symbol.trim().toUpperCase() !== expected.symbol ||
      actual.decimals !== expected.decimals
    ) return null;
  }
  return canonicalExitRouteAssetKey(input.chain, policy.poolAddress);
}

/**
 * Build the atomic two-output packet for the exact reviewed Ethereum 3pool.
 * DAI remains output-only until its measured treatment receives a separate review.
 */
export function buildCurveStableSwapMeasuredExecutionTargets(input: {
  curveData: CurvePoolEntry | undefined;
  chain: string;
  stablecoinId: string;
  chainAddressToId: Map<string, string>;
  stablecoinPriceById?: Map<string, number>;
  retainedTvlUsd: number;
  capturedAt: number;
}): DexMeasuredExecutionTarget[] {
  const { curveData } = input;
  const policy = CURVE_3POOL_STABLESWAP_POLICY;
  const physicalPoolId = resolveReviewedCurveStableSwapPhysicalPoolId({
    curveData,
    chain: input.chain,
  });
  if (
    physicalPoolId == null ||
    !CURVE_3POOL_REVIEWED_INPUT_IDS.has(input.stablecoinId) ||
    !curveData
  ) return [];
  const executionCoins = curveData.executionCoins;
  if (!executionCoins) return [];
  const poolTokenAddresses = policy.poolTokens.map((token) => token.address);
  for (let index = 0; index < policy.poolTokens.length; index += 1) {
    const expected = policy.poolTokens[index]!;
    const actual = executionCoins[index]!;
    if (
      actual.address.toLowerCase() !== expected.address ||
      actual.symbol.trim().toUpperCase() !== expected.symbol ||
      actual.decimals !== expected.decimals ||
      input.chainAddressToId.get(canonicalExitRouteAssetKey(input.chain, actual.address)) !==
        CURVE_3POOL_TRACKED_IDS[index]
    ) return [];
  }
  const referencePrices = CURVE_3POOL_TRACKED_IDS.map((stablecoinId) =>
    input.stablecoinPriceById?.get(stablecoinId)
  );
  if (referencePrices.some((price) => !Number.isFinite(price) || !(price! > 0))) return [];
  const inputIndex = CURVE_3POOL_TRACKED_IDS.indexOf(
    input.stablecoinId as typeof CURVE_3POOL_TRACKED_IDS[number],
  );
  if (inputIndex < 0) return [];
  return policy.poolTokens.flatMap((tokenOutPolicy, outputIndex) => {
    if (outputIndex === inputIndex) return [];
    const tokenInPolicy = policy.poolTokens[inputIndex]!;
    const tokenIn = executionCoins[inputIndex]!;
    const tokenOut = executionCoins[outputIndex]!;
    const targetId = buildDexMeasuredExecutionTargetId({
      adapterProfileId: CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
      stablecoinId: input.stablecoinId,
      chain: input.chain,
      protocol: "curve",
      poolId: physicalPoolId,
      tokenInAddress: tokenInPolicy.address,
      tokenOutAddress: tokenOutPolicy.address,
      poolTokenAddresses,
    });
    return [{
      schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
      targetId,
      stablecoinId: input.stablecoinId,
      adapterProfileId: CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
      protocol: "curve",
      chain: input.chain,
      poolId: physicalPoolId,
      poolTokenAddresses,
      tokenIn: {
        address: tokenInPolicy.address,
        symbol: tokenIn.symbol,
        decimals: tokenIn.decimals,
        referencePriceUsd: referencePrices[inputIndex]!,
        trackedAssetId: input.stablecoinId,
      },
      tokenOut: {
        address: tokenOutPolicy.address,
        symbol: tokenOut.symbol,
        decimals: tokenOut.decimals,
        referencePriceUsd: referencePrices[outputIndex]!,
        trackedAssetId: CURVE_3POOL_TRACKED_IDS[outputIndex],
      },
      retainedTvlUsd: input.retainedTvlUsd,
      retainedPoolPriceUsd: referencePrices[inputIndex]!,
      capturedAt: input.capturedAt,
    }];
  });
}

/**
 * Resolve an otherwise ambiguous Curve coin-set join only when the two source
 * snapshots identify exactly one physical pool by TVL and that address is
 * already in the reviewed active CryptoSwap cohort.
 */
export function resolveActiveCurveCryptoSwapCandidateByTvl(
  candidates: readonly CurvePoolEntry[],
  retainedTvlUsd: number,
  chain: string,
): CurvePoolEntry | null {
  if (!Number.isFinite(retainedTvlUsd) || retainedTvlUsd <= 0) return null;
  const matching = candidates.filter(
    (candidate) =>
      Number.isFinite(candidate.tvl) &&
      candidate.tvl > 0 &&
      Math.abs(candidate.tvl / retainedTvlUsd - 1) <= ACTIVE_CURVE_CRYPTOSWAP_MAX_TVL_RELATIVE_DRIFT,
  );
  if (matching.length !== 1) return null;
  const candidate = matching[0]!;
  if (!candidate.poolAddress || !isCryptoSwap(candidate.registryId) || candidate.isMetaPool || candidate.apiIsBroken) {
    return null;
  }
  const policy = getCurveCryptoSwapShadowPolicy(chain, candidate.poolAddress);
  return policy?.mode === "active" && policy.scoreEligible ? candidate : null;
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
  uniV3ExecutionCandidates: Map<string, UniV3ExecutionCandidate[]> = new Map(),
  stablecoinPriceById?: Map<string, number>,
  measuredTargetCapturedAt = Math.floor(Date.now() / 1000),
  validationReferences?: PriceValidationReferences,
  aerodromeV2ExecutionCandidates: Map<string, EvmV2ExecutionCandidate> = new Map(),
  curvePoolCandidatesByFingerprint: ReadonlyMap<string, readonly CurvePoolEntry[]> = new Map(),
): Map<string, LiquidityMetrics> {
  const metrics = new Map<string, LiquidityMetrics>();
  const enforceDexProjectFilter = dexProjects.size > 0;
  if (!enforceDexProjectFilter) {
    console.warn("[dex-liquidity] DEX project index is empty — project whitelist filter disabled for this run");
  }

  for (const pool of pools) {
    try {
      if (!pool.tvlUsd || pool.tvlUsd < DEX_LIQUIDITY_POOL_MIN_TVL_USD || pool.tvlUsd > 1e12) continue; // Skip dust and corrupt values
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

      // Try to find Curve enrichment data (address-based first, then the
      // coin-set fingerprint — DeFiLlama yields rows carry UUID pool ids, so
      // the address key alone never matches them — then symbol-combo fallback)
      const chainNorm = canonicalExitRouteChain(pool.chain);
      const addrCurveKey = canonicalExitRouteAssetKey(chainNorm, pool.pool);
      const fpCurveKey =
        protocol === "curve" ? buildPoolFingerprint(chainNorm, "curve", pool.underlyingTokens ?? []) : null;
      const symCurveKey = `${chainNorm}:${poolSymbols
        .map((s) => s.toUpperCase())
        .sort()
        .join("-")}`;
      const activeCryptoSwapTvlMatch =
        protocol === "curve" && fpCurveKey != null && !curvePoolMap.has(fpCurveKey)
          ? resolveActiveCurveCryptoSwapCandidateByTvl(
              curvePoolCandidatesByFingerprint.get(fpCurveKey) ?? [],
              pool.tvlUsd,
              chainNorm,
            )
          : null;
      const curveData =
        protocol === "curve"
          ? (curvePoolMap.get(addrCurveKey) ??
            (fpCurveKey != null ? curvePoolMap.get(fpCurveKey) : undefined) ??
            curvePoolMap.get(symCurveKey))
          : undefined;
      const curveMeasuredRouteData =
        activeCryptoSwapTvlMatch ??
        (curvePoolMap.has(addrCurveKey) || (fpCurveKey != null && curvePoolMap.has(fpCurveKey))
          ? curveData
          : undefined);
      // Track whether the match was address-grade (exact address or unambiguous
      // coin-set fingerprint): metapoolAdjustedTvl and the execution model are only
      // valid for the specific physical Curve pool that matched. Symbol fallbacks
      // may hit a different pool sharing the same token pair, so they keep their
      // own TVL and never carry a model.
      const curveAddressMatch =
        curvePoolMap.has(addrCurveKey) || (fpCurveKey != null && curvePoolMap.has(fpCurveKey));
      const uniV3FeePips = protocol === "uniswap-v3" ? parseUniV3FeePips(pool.poolMeta) : null;
      const uniV3ExecutionKey =
        protocol === "uniswap-v3"
          ? buildUniV3ExecutionCandidateKey(chainNorm, pool.underlyingTokens, uniV3FeePips)
          : null;
      const uniV3Candidates = uniV3ExecutionKey ? (uniV3ExecutionCandidates.get(uniV3ExecutionKey) ?? []) : [];
      const aerodromeExecutionKey =
        protocol === "aerodrome" ? canonicalExitRouteAssetKey(chainNorm, pool.pool) : null;
      const aerodromeV2ExecutionCandidate = aerodromeExecutionKey
        ? aerodromeV2ExecutionCandidates.get(aerodromeExecutionKey)
        : undefined;

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
        const curveExecutionCapability =
          protocol === "curve"
            ? buildCurveStableswapExecutionCapability(
                curveAddressMatch ? curveData : undefined,
                chainNorm,
                id,
                chainAddressToId,
              )
            : { executionModel: null, gate: null };
        const ammExecutionModel = curveExecutionCapability.executionModel;
        const curveCryptoSwapMeasuredTarget =
          protocol === "curve" && curveMeasuredRouteData
            ? buildCurveCryptoSwapMeasuredExecutionTarget({
                curveData: curveMeasuredRouteData,
                chain: chainNorm,
                stablecoinId: id,
                chainAddressToId,
                stablecoinPriceById,
                retainedTvlUsd: rawContribTvl,
                capturedAt: measuredTargetCapturedAt,
              })
            : null;
        const curveStableSwapMeasuredTargets =
          protocol === "curve" && curveAddressMatch
            ? buildCurveStableSwapMeasuredExecutionTargets({
                curveData,
                chain: chainNorm,
                stablecoinId: id,
                chainAddressToId,
                stablecoinPriceById,
                retainedTvlUsd: rawContribTvl,
                capturedAt: measuredTargetCapturedAt,
              })
            : [];
        const curveStableSwapPhysicalPoolId =
          protocol === "curve" && curveAddressMatch
            ? resolveReviewedCurveStableSwapPhysicalPoolId({
                curveData,
                chain: chainNorm,
              })
            : null;
        const uniV3MeasuredTarget =
          protocol === "uniswap-v3" && uniV3Candidates.length === 1
            ? buildUniV3MeasuredExecutionTarget({
                stablecoinId: id,
                candidate: uniV3Candidates[0]!,
                stablecoinPriceById,
                chainAddressToId,
                symbolToChainScopedIds,
                validationReferences,
                retainedTvlUsd: rawContribTvl,
                capturedAt: measuredTargetCapturedAt,
              })
            : null;
        const measuredExecutionTarget = curveCryptoSwapMeasuredTarget ?? uniV3MeasuredTarget;
        const measuredExecutionGate: DexExecutionCapabilityGate | null =
          protocol === "uniswap-v3" && !uniV3MeasuredTarget
            ? { family: "measured-execution", reason: "target-unresolved" }
            : null;
        const evmV2ExecutionCandidate =
          (resolvedPoolType === "aerodrome-volatile" ? aerodromeV2ExecutionCandidate : undefined) ??
          buildEvmV2ExecutionCandidate({
            chain: chainNorm,
            protocol: pool.project,
            poolType: resolvedPoolType,
            poolAddress: pool.pool,
            tokenAddresses: pool.underlyingTokens ?? [],
            tokenSymbols: parsePoolSymbols(pool.symbol),
          });

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
            ...(evmV2ExecutionCandidate ? { evmV2ExecutionCandidate } : {}),
            ...(curveExecutionCapability.gate && !curveCryptoSwapMeasuredTarget
              ? { executionCapabilityGate: curveExecutionCapability.gate }
              : measuredExecutionGate
                ? { executionCapabilityGate: measuredExecutionGate }
                : {}),
            ...(measuredExecutionTarget ? { measuredExecutionTarget } : {}),
            ...(curveStableSwapMeasuredTargets.length === 2
              ? { measuredExecutionTargets: curveStableSwapMeasuredTargets }
              : {}),
            ...(curveStableSwapPhysicalPoolId
              ? { measuredExecutionPhysicalPoolId: curveStableSwapPhysicalPoolId }
              : {}),
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
