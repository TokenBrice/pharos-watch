/** Cross-runtime builders for measured-execution tests. */
import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
  DEX_MEASURED_MAX_COST_BPS,
  DEX_MEASURED_TARGET_SCHEMA_VERSION,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionPublicProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";

export function makeMeasuredTarget(
  overrides: Partial<DexMeasuredExecutionTarget> & {
    tokenIn?: Partial<DexMeasuredExecutionTarget["tokenIn"]>;
    tokenOut?: Partial<DexMeasuredExecutionTarget["tokenOut"]>;
  } = {},
): DexMeasuredExecutionTarget {
  const poolTokenAddresses = overrides.poolTokenAddresses ?? [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ];
  const stablecoinId = overrides.stablecoinId ?? "usdc-circle";
  const chain = overrides.chain ?? "ethereum";
  const protocol = overrides.protocol ?? "uniswap-v3";
  const poolId = overrides.poolId ?? `${chain}:0x3333333333333333333333333333333333333333`;
  const tokenIn = {
    address: poolTokenAddresses[0]!,
    symbol: "INPUT",
    decimals: 6,
    referencePriceUsd: 1,
    trackedAssetId: stablecoinId,
    ...overrides.tokenIn,
  };
  const tokenOut = {
    address: poolTokenAddresses[1]!,
    symbol: "OUTPUT",
    decimals: 6,
    referencePriceUsd: 1,
    trackedAssetId: "output-asset",
    ...overrides.tokenOut,
  };
  const targetId = overrides.targetId ?? buildDexMeasuredExecutionTargetId({
    adapterProfileId: overrides.adapterProfileId ?? "uniswap-v3-quoter-v2",
    stablecoinId,
    chain,
    protocol,
    poolId,
    tokenInAddress: tokenIn.address,
    tokenOutAddress: tokenOut.address,
    poolTokenAddresses,
  });
  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId,
    stablecoinId,
    adapterProfileId: overrides.adapterProfileId ?? "uniswap-v3-quoter-v2",
    protocol,
    chain,
    poolId,
    poolTokenAddresses,
    retainedTvlUsd: 1_000_000,
    retainedPoolPriceUsd: tokenIn.referencePriceUsd,
    capturedAt: 1_752_500_000,
    ...overrides,
    tokenIn,
    tokenOut,
  };
}

export function makeMeasuredProfile(
  quotedAt: number,
  overrides: Partial<DexMeasuredExecutionPublicProfile> = {},
): DexMeasuredExecutionPublicProfile {
  const capacityCurve = DEX_MEASURED_CAPACITY_NOTIONALS_USD.map((requestedNotionalUsd) => {
    const executableUsd = Math.min(requestedNotionalUsd, 1_000_000);
    return {
      requestedNotionalUsd,
      maxCostBps: DEX_MEASURED_MAX_COST_BPS,
      executableUsd,
      completionRatio: executableUsd / requestedNotionalUsd,
    };
  });
  return {
    schemaVersion: DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
    kind: "measured-executable-depth",
    targetId: "target-1",
    targetGenerationId: "target-generation",
    quoteGenerationId: "quote-generation",
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "ethereum",
    poolId: "ethereum:0x3333333333333333333333333333333333333333",
    poolTokenAddresses: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ],
    tokenIn: {
      address: "0x1111111111111111111111111111111111111111",
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    tokenOut: {
      address: "0x2222222222222222222222222222222222222222",
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdt-tether",
    },
    feePips: 100,
    retainedTvlUsdAtQuote: 2_000_000,
    retainedPoolPriceUsdAtQuote: 1,
    quotedAt,
    blockNumber: 25_536_894,
    executionEndpoint: {
      address: "0x4444444444444444444444444444444444444444",
      codeHash: `0x${"ab".repeat(32)}`,
    },
    poolProvenance: {
      factoryAddress: "0x5555555555555555555555555555555555555555",
      factoryCodeHash: `0x${"cd".repeat(32)}`,
      resolvedPoolAddress: "0x3333333333333333333333333333333333333333",
    },
    maxCostBps: DEX_MEASURED_MAX_COST_BPS,
    marginalOutputRatio: 0.999,
    capacityCurve,
    ...overrides,
  };
}

export function withMeasuredObservationHistory(
  profile: DexMeasuredExecutionPublicProfile,
  successfulObservationCount: number,
  conservativeExecutableUsd: number,
): DexMeasuredExecutionPublicProfile {
  const conservativeCapacityCurve = profile.capacityCurve.map((point) => {
    const executableUsd = Math.min(point.executableUsd, conservativeExecutableUsd);
    return {
      ...point,
      executableUsd,
      completionRatio: executableUsd / point.requestedNotionalUsd,
    };
  });
  return {
    ...profile,
    observationHistory: {
      completeProducerCycleCount: successfulObservationCount,
      successfulObservationCount,
      consecutiveSuccessCount: successfulObservationCount,
      observationWindowStartedAt: profile.quotedAt - 1_000,
      observationWindowEndedAt: profile.quotedAt + 10,
      latestOperationalFailureAt: null,
      conservativeStatistic: "pointwise-minimum",
      conservativeCapacityCurve,
    },
  };
}
