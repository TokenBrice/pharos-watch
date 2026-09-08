import {
  DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
  DEX_MEASURED_MAX_COST_BPS,
  buildDexMeasuredCapacityCurve,
  buildDexMeasuredExecutionTargetId,
  validateDexMeasuredExecutionProfile,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionQuotePointProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";

export const TOKEN_IN = {
  address: "0x1111111111111111111111111111111111111111",
  symbol: "USD1",
  decimals: 6,
  referencePriceUsd: 1,
  trackedAssetId: "usd1",
};
export const TOKEN_OUT = {
  address: "0x2222222222222222222222222222222222222222",
  symbol: "USDC",
  decimals: 6,
  referencePriceUsd: 1,
  trackedAssetId: "usdc-circle",
};

export function proofPoint(inputUsd: number, outputUsd: number) {
  const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
  return {
    amountInRaw: String(Math.round(inputUsd * 1_000_000)),
    amountOutRaw: String(Math.round(outputUsd * 1_000_000)),
    callData: "0x1234",
    returnData: "0xabcd",
    inputUsd,
    outputUsd,
    costBps,
    passesCostBound: costBps <= DEX_MEASURED_MAX_COST_BPS,
  };
}

export function revertedProofPoint(inputUsd: number): DexMeasuredExecutionQuotePointProof {
  return {
    amountInRaw: String(Math.round(inputUsd * 1_000_000)),
    amountOutRaw: "0",
    callData: "0x1234",
    returnData: "0x",
    inputUsd,
    outputUsd: 0,
    costBps: 10_000,
    passesCostBound: false,
    reverted: true,
  };
}

export function target(nowSec = 10_000, overrides: Partial<DexMeasuredExecutionTarget> = {}): DexMeasuredExecutionTarget {
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId: buildDexMeasuredExecutionTargetId({
      adapterProfileId: "uniswap-v3-quoter-v2",
      stablecoinId: "usd1",
      chain: "ethereum",
      protocol: "uniswap-v3",
      poolId: "0x3333333333333333333333333333333333333333",
      tokenInAddress: TOKEN_IN.address,
      tokenOutAddress: TOKEN_OUT.address,
      feePips: 500,
    }),
    stablecoinId: "usd1",
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "ethereum",
    poolId: "0x3333333333333333333333333333333333333333",
    tokenIn: { ...TOKEN_IN },
    tokenOut: { ...TOKEN_OUT },
    feePips: 500,
    retainedTvlUsd: 1_000_000,
    retainedPoolPriceUsd: 1,
    capturedAt: nowSec - 600,
    ...overrides,
  };
}

export function profile(nowSec = 10_000, quotedTarget = target(nowSec), overrides: Partial<DexMeasuredExecutionProfile> = {}): DexMeasuredExecutionProfile {
  const quoteProof = [
    proofPoint(1_000, 999),
    proofPoint(100_000, 99_000),
    proofPoint(1_000_000, 970_000),
  ];
  return {
    schemaVersion: DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
    kind: "measured-executable-depth",
    targetId: quotedTarget.targetId,
    targetGenerationId: "targets-1",
    quoteGenerationId: "quotes-1",
    adapterProfileId: quotedTarget.adapterProfileId,
    protocol: quotedTarget.protocol,
    chain: quotedTarget.chain,
    poolId: quotedTarget.poolId,
    tokenIn: { ...quotedTarget.tokenIn },
    tokenOut: { ...quotedTarget.tokenOut },
    feePips: quotedTarget.feePips,
    retainedTvlUsdAtQuote: quotedTarget.retainedTvlUsd,
    retainedPoolPriceUsdAtQuote: quotedTarget.retainedPoolPriceUsd,
    quotedAt: nowSec - 60,
    blockNumber: 123,
    executionEndpoint: {
      address: "0x4444444444444444444444444444444444444444",
      codeHash: `0x${"ab".repeat(32)}`,
    },
    maxCostBps: DEX_MEASURED_MAX_COST_BPS,
    marginalOutputRatio: 0.999,
    quoteProof,
    capacityCurve: buildDexMeasuredCapacityCurve(quoteProof, quotedTarget.retainedTvlUsd),
    ...(quotedTarget.poolTokenAddresses ? { poolTokenAddresses: [...quotedTarget.poolTokenAddresses] } : {}),
    ...overrides,
  };
}

export function validationInput(
  measuredProfile: DexMeasuredExecutionProfile,
  nowSec: number,
  overrides: Partial<Parameters<typeof validateDexMeasuredExecutionProfile>[0]> = {},
): Parameters<typeof validateDexMeasuredExecutionProfile>[0] {
  return {
    profile: measuredProfile,
    quotedTarget: target(nowSec),
    currentTarget: target(nowSec),
    expectedTargetGenerationId: "targets-1",
    expectedQuoteGenerationId: "quotes-1",
    nowSec,
    ...overrides,
  };
}
