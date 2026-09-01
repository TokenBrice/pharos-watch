import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import type {
  CurvePoolEntry,
  CurveStableswapRateInputExecutionCandidate,
} from "./types";
import { isCryptoSwap } from "./pool-helpers";
import type { DexAmmExecutionModel, DexExecutionCapabilityGate } from "@shared/types/market";
import {
  DEX_MEASURED_TARGET_SCHEMA_VERSION,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  buildUniV3ExecutionCandidateKey,
  buildUniswapV4ExecutionCandidateKey,
  buildUniswapV4MeasuredExecutionTarget,
  buildUniV3MeasuredExecutionTarget,
  parseUniV3FeePips,
} from "../measured-execution/inventory";
import {
  CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  getCurveCryptoSwapShadowPolicy,
} from "../measured-execution/curve-cryptoswap";
import {
  CURVE_3POOL_STABLESWAP_POLICY,
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
} from "../measured-execution/curve-stableswap";
import {
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  getCurveStableSwapNgPolicy,
} from "../measured-execution/curve-stableswap-ng";
import { buildCurveCompositeMeasuredExecutionTarget } from "../measured-execution/curve-composite";
import {
  buildEvmV2ExecutionCandidate,
  resolveEvmV2ExecutionCandidate,
} from "./constant-product-v2";
import { CURVE_STABLESWAP_FEE_BOUND } from "./curve-stableswap-rates";
import { parsePoolSymbols } from "./pool-helpers";
import type {
  PoolExecutionCapability,
  PoolProcessingContext,
  PoolProtocolEnrichment,
  ResolvedPoolIdentity,
} from "./process-pool-types";
import { buildRegisteredDexExecutionTarget } from "./execution-target-registry";

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
  rateInputCandidate?: CurveStableswapRateInputExecutionCandidate;
}

function buildCurveStableswapRateInputExecutionCandidate(
  curveData: CurvePoolEntry,
): CurveStableswapRateInputExecutionCandidate | null {
  if (curveData.registryId.trim().toLowerCase() !== "factory-stable-ng") return null;
  const poolAddress = curveData.poolAddress?.trim().toLowerCase();
  const coins = curveData.executionCoins;
  if (!poolAddress || !/^0x[a-f0-9]{40}$/.test(poolAddress) || !coins || coins.length < 2 || coins.length > 8) {
    return null;
  }
  const candidateCoins = coins.map((coin) => {
    const address = coin.address.trim().toLowerCase();
    if (
      !/^0x[a-f0-9]{40}$/.test(address) ||
      !coin.symbol.trim() ||
      !Number.isInteger(coin.decimals) ||
      coin.decimals < 0 ||
      coin.decimals > 36 ||
      !Number.isFinite(coin.usdPrice) ||
      coin.usdPrice <= 0
    ) {
      return null;
    }
    return {
      address: address as `0x${string}`,
      symbol: coin.symbol,
      decimals: coin.decimals,
      referencePriceUsd: coin.usdPrice,
    };
  });
  if (candidateCoins.some((coin) => coin == null)) return null;
  const exactCoins = candidateCoins as NonNullable<typeof candidateCoins[number]>[];
  if (new Set(exactCoins.map((coin) => coin.address)).size !== exactCoins.length) return null;
  return { poolAddress: poolAddress as `0x${string}`, coins: exactCoins };
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
    const rateInputCandidate = buildCurveStableswapRateInputExecutionCandidate(curveData);
    return {
      executionModel: null,
      gate: { family: "curve-stableswap", reason: "rate-bearing-inputs" },
      ...(rateInputCandidate ? { rateInputCandidate } : {}),
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

/** @internal Exported for focused Curve StableSwap model tests. */
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
  if (!policy) return null;
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

export function resolveReviewedCurveStableSwapNgPhysicalPoolId(input: {
  curveData: CurvePoolEntry | undefined;
  chain: string;
}): string | null {
  const { curveData } = input;
  const policy = curveData?.poolAddress
    ? getCurveStableSwapNgPolicy(input.chain, curveData.poolAddress)
    : null;
  if (
    !policy ||
    input.chain !== policy.chain ||
    !curveData ||
    curveData.apiIsBroken ||
    curveData.isMetaPool ||
    curveData.registryId.trim().toLowerCase() !== "factory-stable-ng" ||
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

/** Build only reviewed StableSwap-NG get_dy directions. */
export function buildCurveStableSwapNgMeasuredExecutionTarget(input: {
  curveData: CurvePoolEntry | undefined;
  chain: string;
  stablecoinId: string;
  chainAddressToId: Map<string, string>;
  stablecoinPriceById?: Map<string, number>;
  retainedTvlUsd: number;
  capturedAt: number;
}): DexMeasuredExecutionTarget | null {
  const { curveData } = input;
  const policy = curveData?.poolAddress
    ? getCurveStableSwapNgPolicy(input.chain, curveData.poolAddress)
    : null;
  const physicalPoolId = resolveReviewedCurveStableSwapNgPhysicalPoolId({
    curveData,
    chain: input.chain,
  });
  if (
    !policy ||
    physicalPoolId == null ||
    input.stablecoinId !== policy.stablecoinId ||
    !curveData?.executionCoins
  ) return null;

  for (let index = 0; index < policy.poolTokens.length; index += 1) {
    const expected = policy.poolTokens[index]!;
    const actual = curveData.executionCoins[index]!;
    if (
      actual.address.toLowerCase() !== expected.address ||
      actual.symbol.trim().toUpperCase() !== expected.symbol ||
      actual.decimals !== expected.decimals ||
      input.chainAddressToId.get(canonicalExitRouteAssetKey(input.chain, actual.address)) !==
        expected.trackedAssetId
    ) return null;
  }

  const tokenInPolicy = policy.poolTokens[policy.inputIndex];
  const tokenOutPolicy = policy.poolTokens[policy.outputIndex];
  const tokenIn = curveData.executionCoins[policy.inputIndex];
  const tokenOut = curveData.executionCoins[policy.outputIndex];
  const inputReferencePriceUsd = input.stablecoinPriceById?.get(tokenInPolicy.trackedAssetId);
  const outputReferencePriceUsd = input.stablecoinPriceById?.get(tokenOutPolicy.trackedAssetId);
  if (
    !Number.isFinite(inputReferencePriceUsd) ||
    !(inputReferencePriceUsd! > 0) ||
    !Number.isFinite(outputReferencePriceUsd) ||
    !(outputReferencePriceUsd! > 0)
  ) return null;
  const poolTokenAddresses = policy.poolTokens.map((token) => token.address);
  const targetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
    stablecoinId: input.stablecoinId,
    chain: input.chain,
    protocol: "curve",
    poolId: physicalPoolId,
    tokenInAddress: tokenInPolicy.address,
    tokenOutAddress: tokenOutPolicy.address,
    poolTokenAddresses,
  });
  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId,
    stablecoinId: input.stablecoinId,
    adapterProfileId: CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
    protocol: "curve",
    chain: input.chain,
    poolId: physicalPoolId,
    poolTokenAddresses,
    tokenIn: {
      address: tokenInPolicy.address,
      symbol: tokenIn.symbol,
      decimals: tokenIn.decimals,
      referencePriceUsd: inputReferencePriceUsd!,
      trackedAssetId: tokenInPolicy.trackedAssetId,
    },
    tokenOut: {
      address: tokenOutPolicy.address,
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals,
      referencePriceUsd: outputReferencePriceUsd!,
      trackedAssetId: tokenOutPolicy.trackedAssetId,
    },
    retainedTvlUsd: input.retainedTvlUsd,
    retainedPoolPriceUsd: inputReferencePriceUsd!,
    capturedAt: input.capturedAt,
  };
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
  return policy ? candidate : null;
}

/**
 * Resolve a Curve coin-set join that failed closed because two physical pools
 * share the same coins. The retained DeFiLlama TVL identifies exactly one of
 * them, and only a plain StableSwap pool is admitted: CryptoSwap and metapool
 * candidates keep the unresolved join rather than crossing into a family this
 * execution capability cannot model. The drift tolerance is the one the
 * CryptoSwap join already uses.
 */
export function resolveCurveStableswapCandidateByTvl(
  candidates: readonly CurvePoolEntry[],
  retainedTvlUsd: number,
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
  if (
    candidate.apiIsBroken ||
    candidate.isMetaPool ||
    isCryptoSwap(candidate.registryId) ||
    !candidate.executionCoins
  ) {
    return null;
  }
  return candidate;
}

export function buildPoolExecutionCapability(
  context: PoolProcessingContext,
  identity: ResolvedPoolIdentity,
  enrichment: PoolProtocolEnrichment,
  stablecoinId: string,
): PoolExecutionCapability {
  const { pool, protocol, chainNorm } = identity;
  const {
    curveAddressMatch,
    curveData,
    curveMeasuredRouteData,
    rawContribTvl,
    resolvedPoolType,
  } = enrichment;
  const curveStableswapExecutionMatch =
    protocol === "curve" &&
    !curveAddressMatch &&
    identity.fpCurveKey != null
      ? resolveCurveStableswapCandidateByTvl(
          context.curvePoolCandidatesByFingerprint.get(identity.fpCurveKey) ?? [],
          pool.tvlUsd,
        )
      : null;
  const curveExecutionCapability =
    protocol === "curve"
      ? buildCurveStableswapExecutionCapability(
          curveAddressMatch
            ? curveData
            : (curveStableswapExecutionMatch ?? undefined),
          chainNorm,
          stablecoinId,
          context.chainAddressToId,
        )
      : { executionModel: null, gate: null };
  const curveCryptoSwapMeasuredTarget =
    protocol === "curve" && curveMeasuredRouteData
      ? buildCurveCryptoSwapMeasuredExecutionTarget({
          curveData: curveMeasuredRouteData,
          chain: chainNorm,
          stablecoinId,
          chainAddressToId: context.chainAddressToId,
          stablecoinPriceById: context.stablecoinPriceById,
          retainedTvlUsd: rawContribTvl,
          capturedAt: context.measuredTargetCapturedAt,
        })
      : null;
  const curveStableSwapMeasuredTargets =
    protocol === "curve" && curveAddressMatch
      ? buildCurveStableSwapMeasuredExecutionTargets({
          curveData,
          chain: chainNorm,
          stablecoinId,
          chainAddressToId: context.chainAddressToId,
          stablecoinPriceById: context.stablecoinPriceById,
          retainedTvlUsd: rawContribTvl,
          capturedAt: context.measuredTargetCapturedAt,
        })
      : [];
  const curveStableSwapNgMeasuredTarget =
    protocol === "curve" && curveAddressMatch
      ? buildCurveStableSwapNgMeasuredExecutionTarget({
          curveData,
          chain: chainNorm,
          stablecoinId,
          chainAddressToId: context.chainAddressToId,
          stablecoinPriceById: context.stablecoinPriceById,
          retainedTvlUsd: rawContribTvl,
          capturedAt: context.measuredTargetCapturedAt,
        })
      : null;
  const curveCompositeMeasuredTarget =
    protocol === "curve" && curveAddressMatch
      ? buildCurveCompositeMeasuredExecutionTarget({
          curveData,
          chain: chainNorm,
          stablecoinId,
          chainAddressToId: context.chainAddressToId,
          stablecoinPriceById: context.stablecoinPriceById,
          retainedTvlUsd: rawContribTvl,
          capturedAt: context.measuredTargetCapturedAt,
        })
      : null;
  const curveStableSwapPhysicalPoolId =
    protocol === "curve" && curveAddressMatch
      ? resolveReviewedCurveStableSwapPhysicalPoolId({
          curveData,
          chain: chainNorm,
        })
      : null;

  const uniV3FeePips =
    protocol === "uniswap-v3" ? parseUniV3FeePips(pool.poolMeta) : null;
  const uniV3ExecutionKey =
    protocol === "uniswap-v3"
      ? buildUniV3ExecutionCandidateKey(
          chainNorm,
          pool.underlyingTokens,
          uniV3FeePips,
        )
      : null;
  const uniV3Candidates = uniV3ExecutionKey
    ? (context.uniV3ExecutionCandidates.get(uniV3ExecutionKey) ?? [])
    : [];
  const uniV3MeasuredTarget =
    protocol === "uniswap-v3" && uniV3Candidates.length === 1
      ? buildUniV3MeasuredExecutionTarget({
          stablecoinId,
          candidate: uniV3Candidates[0]!,
          stablecoinPriceById: context.stablecoinPriceById,
          chainAddressToId: context.chainAddressToId,
          symbolToChainScopedIds: context.symbolToChainScopedIds,
          validationReferences: context.validationReferences,
          retainedTvlUsd: rawContribTvl,
          capturedAt: context.measuredTargetCapturedAt,
        })
      : null;

  const uniswapV4FeePips =
    protocol === "uniswap-v4" ? parseUniV3FeePips(pool.poolMeta) : null;
  const uniswapV4ExecutionKey =
    protocol === "uniswap-v4"
      ? buildUniswapV4ExecutionCandidateKey(
          chainNorm,
          pool.underlyingTokens,
          uniswapV4FeePips,
        )
      : null;
  const uniswapV4Candidates = uniswapV4ExecutionKey
    ? (context.uniswapV4ExecutionCandidates.get(uniswapV4ExecutionKey) ?? [])
    : [];
  const uniswapV4MeasuredTarget =
    protocol === "uniswap-v4" && uniswapV4Candidates.length === 1
      ? buildUniswapV4MeasuredExecutionTarget({
          stablecoinId,
          candidate: uniswapV4Candidates[0]!,
          stablecoinPriceById: context.stablecoinPriceById,
          chainAddressToId: context.chainAddressToId,
          symbolToChainScopedIds: context.symbolToChainScopedIds,
          validationReferences: context.validationReferences,
          retainedTvlUsd: rawContribTvl,
          capturedAt: context.measuredTargetCapturedAt,
        })
      : null;
  const measuredExecutionTarget =
    curveCryptoSwapMeasuredTarget ??
    curveStableSwapNgMeasuredTarget ??
    curveCompositeMeasuredTarget ??
    uniV3MeasuredTarget ??
    uniswapV4MeasuredTarget;
  const curveStableswapRateInputExecutionCandidate =
    curveExecutionCapability.rateInputCandidate &&
    measuredExecutionTarget == null &&
    curveStableSwapMeasuredTargets.length === 0
      ? curveExecutionCapability.rateInputCandidate
      : undefined;
  const measuredExecutionGate: DexExecutionCapabilityGate | null =
    (protocol === "uniswap-v3" && !uniV3MeasuredTarget) ||
    (protocol === "uniswap-v4" && !uniswapV4MeasuredTarget)
      ? { family: "measured-execution", reason: "target-unresolved" }
      : null;
  const aerodromeV2ExecutionCandidate =
    protocol === "aerodrome"
      ? resolveEvmV2ExecutionCandidate({
          chain: chainNorm,
          protocol: pool.project,
          poolAddressOrId: pool.pool,
          tokenAddresses: pool.underlyingTokens ?? [],
          exactCandidates: context.aerodromeV2ExecutionCandidates,
          uniqueFingerprintCandidates:
            context.uniqueAerodromeV2ExecutionCandidates,
        })
      : undefined;
  const evmV2ExecutionCandidate =
    (resolvedPoolType === "aerodrome-volatile"
      ? aerodromeV2ExecutionCandidate
      : undefined) ??
    buildEvmV2ExecutionCandidate({
      chain: chainNorm,
      protocol: pool.project,
      poolType: resolvedPoolType,
      poolAddress: pool.pool,
      tokenAddresses: pool.underlyingTokens ?? [],
      tokenSymbols: parsePoolSymbols(pool.symbol),
    });
  const executionCapabilityGate =
    curveExecutionCapability.gate &&
    !curveCryptoSwapMeasuredTarget &&
    !curveStableSwapNgMeasuredTarget &&
    !curveCompositeMeasuredTarget
      ? curveExecutionCapability.gate
      : measuredExecutionGate;
  const registeredTarget = buildRegisteredDexExecutionTarget({
    context,
    identity,
    enrichment,
    stablecoinId,
  });

  return {
    ...(curveExecutionCapability.executionModel
      ? { ammExecutionModel: curveExecutionCapability.executionModel }
      : {}),
    ...(evmV2ExecutionCandidate ? { evmV2ExecutionCandidate } : {}),
    ...(curveStableswapRateInputExecutionCandidate
      ? { curveStableswapRateInputExecutionCandidate }
      : {}),
    ...(executionCapabilityGate ? { executionCapabilityGate } : {}),
    ...(measuredExecutionTarget ? { measuredExecutionTarget } : {}),
    ...(curveStableSwapMeasuredTargets.length === 2
      ? { measuredExecutionTargets: curveStableSwapMeasuredTargets }
      : {}),
    ...(curveStableSwapPhysicalPoolId
      ? { measuredExecutionPhysicalPoolId: curveStableSwapPhysicalPoolId }
      : {}),
    ...registeredTarget,
  };
}
