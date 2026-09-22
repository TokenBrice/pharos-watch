import {
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { makeMeasuredTarget } from "@shared/test-utils/measured-execution.test-support";
import { buildDexMeasuredExecutionProfile, type DexMeasuredRawQuotePoint } from "../profiles";
import {
  CURVE_3POOL_STABLESWAP_POLICY,
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
  encodeCurveStableSwapGetDy,
} from "../curve-stableswap";
import {
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  CURVE_USDG_USDC_STABLESWAP_NG_POLICY,
  encodeCurveStableSwapNgGetDy,
} from "../curve-stableswap-ng";
import {
  CURVE_R3_METAPOOL_POLICIES,
  encodeCurveCompositeQuote,
  type CurveMetapoolPolicy,
} from "../curve-composite";
import {
  UNISWAP_V4_ADAPTER_PROFILE_ID,
  UNISWAP_V4_HOOK_FREE_ADDRESS,
  getUniswapV4Deployment,
} from "../uniswap-v4";

export const CURVE_3POOL_TOKEN_ADDRESSES =
  CURVE_3POOL_STABLESWAP_POLICY.poolTokens.map((token) => token.address);

export function makeCurve3PoolPacket() {
  const policy = CURVE_3POOL_STABLESWAP_POLICY;
  const stablecoinIds = ["dai-makerdao", "usdc-circle", "usdt-tether"];
  const inputIndex = 2;
  const poolId = `ethereum:${policy.poolAddress}`;
  const targets = [0, 1].map((outputIndex): DexMeasuredExecutionTarget => {
    const tokenInPolicy = policy.poolTokens[inputIndex]!;
    const tokenOutPolicy = policy.poolTokens[outputIndex]!;
    const base = {
      schemaVersion: "dex-measured-target-v1" as const,
      stablecoinId: "usdt-tether",
      adapterProfileId: CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
      protocol: "curve",
      chain: "ethereum",
      poolId,
      poolTokenAddresses: CURVE_3POOL_TOKEN_ADDRESSES,
      tokenIn: {
        address: tokenInPolicy.address,
        symbol: tokenInPolicy.symbol,
        decimals: tokenInPolicy.decimals,
        referencePriceUsd: 1,
        trackedAssetId: "usdt-tether",
      },
      tokenOut: {
        address: tokenOutPolicy.address,
        symbol: tokenOutPolicy.symbol,
        decimals: tokenOutPolicy.decimals,
        referencePriceUsd: 1,
        trackedAssetId: stablecoinIds[outputIndex],
      },
      retainedTvlUsd: 160_000_000,
      retainedPoolPriceUsd: 1,
      capturedAt: 1_000,
    };
    return {
      ...base,
      targetId: buildDexMeasuredExecutionTargetId({
        adapterProfileId: base.adapterProfileId,
        stablecoinId: base.stablecoinId,
        chain: base.chain,
        protocol: base.protocol,
        poolId: base.poolId,
        tokenInAddress: base.tokenIn.address,
        tokenOutAddress: base.tokenOut.address,
        poolTokenAddresses: CURVE_3POOL_TOKEN_ADDRESSES,
      }),
    };
  });
  const profiles = targets.map((measuredTarget) => {
    const inputIndex = measuredTarget.poolTokenAddresses!.indexOf(measuredTarget.tokenIn.address);
    const outputIndex = measuredTarget.poolTokenAddresses!.indexOf(measuredTarget.tokenOut.address);
    const points = [1_000, 100_000, 1_000_000, 10_000_000, 25_000_000].map((inputUsd) => {
      const amountInRaw = BigInt(inputUsd) * 10n ** BigInt(measuredTarget.tokenIn.decimals);
      const amountOutRaw =
        BigInt(Math.round(inputUsd * 0.99)) * 10n ** BigInt(measuredTarget.tokenOut.decimals);
      return {
        amountInRaw: amountInRaw.toString(),
        amountOutRaw: amountOutRaw.toString(),
        callData: encodeCurveStableSwapGetDy({ inputIndex, outputIndex, amountInRaw }),
        returnData: `0x${amountOutRaw.toString(16).padStart(64, "0")}` as `0x${string}`,
        inputUsd,
        outputUsd: inputUsd * 0.99,
        costBps: 100,
        passesCostBound: true,
      };
    });
    return buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "curve-target-generation",
      quoteGenerationId: "curve-quote-generation",
      quotedAt: 1_060,
      blockNumber: 25_601_051,
      endpointAddress: policy.poolAddress,
      endpointCodeHash: policy.expectedPoolCodeHash,
      points,
    });
  });
  return { targets, profiles };
}

export function makeCurveCompositeReferenceMaps() {
  const chainAddressToId = new Map([
    ["ethereum:0x865377367054516e17014ccded1e7d814edc9ce4", "dola-inverse-finance"],
    ["ethereum:0x9d39a5de30e57443bff2a8307a4256c8797a3497", "susde-ethena"],
    ["ethereum:0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", "usd1-world-liberty-financial"],
    ["ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc-circle"],
    ["ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt-tether"],
    ["avalanche:0xf14f4ce569cb3679e99d5059909e23b07bd2f387", "nxusd-nereus"],
  ]);
  const stablecoinPriceById = new Map([
    ["dola-inverse-finance", 0.996],
    ["susde-ethena", 1.24],
    ["usd1-world-liberty-financial", 0.999],
    ["usdc-circle", 1],
    ["usdt-tether", 0.999],
    ["nxusd-nereus", 0.8094],
  ]);
  for (const policy of CURVE_R3_METAPOOL_POLICIES) {
    if (!stablecoinPriceById.has(policy.stablecoinId)) {
      stablecoinPriceById.set(policy.stablecoinId, 1);
    }
    for (const token of policy.executionTokens) {
      if (token.trackedAssetId) {
        chainAddressToId.set(`${policy.chain}:${token.address}`, token.trackedAssetId);
      }
    }
  }
  return { chainAddressToId, stablecoinPriceById };
}

function makeRoutePacket(
  measuredTarget: DexMeasuredExecutionTarget,
  input: {
    targetGenerationId: string;
    quoteGenerationId: string;
    endpointAddress: `0x${string}`;
    endpointCodeHash: `0x${string}`;
    points: DexMeasuredRawQuotePoint[];
  },
) {
  return {
    measuredTarget,
    profile: buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      ...input,
      quotedAt: 1_060,
      blockNumber: 25_601_359,
    }),
  };
}

export function makeCurveStableSwapNgRoute() {
  const policy = CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
  const measuredTarget = makeMeasuredTarget({
    stablecoinId: policy.stablecoinId,
    adapterProfileId: CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
    protocol: "curve",
    chain: policy.chain,
    poolId: `${policy.chain}:${policy.poolAddress}`,
    poolTokenAddresses: policy.poolTokens.map((token) => token.address),
    tokenIn: { ...policy.poolTokens[policy.inputIndex], referencePriceUsd: 1 },
    tokenOut: { ...policy.poolTokens[policy.outputIndex], referencePriceUsd: 1 },
    retainedTvlUsd: 20_501_133,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
  });
  const points = [1_000, 100_000, 1_000_000, 10_000_000, 25_000_000].map((inputUsd) => {
    const amountInRaw = BigInt(inputUsd) * 1_000_000n;
    const outputUsd = Math.min(inputUsd * 0.999, 10_325_100);
    const amountOutRaw = BigInt(Math.round(outputUsd * 1_000_000));
    return {
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: encodeCurveStableSwapNgGetDy({
        inputIndex: policy.inputIndex,
        outputIndex: policy.outputIndex,
        amountInRaw,
      }),
      returnData: `0x${amountOutRaw.toString(16).padStart(64, "0")}` as `0x${string}`,
      inputUsd,
      outputUsd,
      costBps: Math.max(0, (1 - outputUsd / inputUsd) * 10_000),
      passesCostBound: outputUsd / inputUsd >= 0.98,
    };
  });
  return makeRoutePacket(measuredTarget, {
    targetGenerationId: "curve-ng-target-generation",
    quoteGenerationId: "curve-ng-quote-generation",
    endpointAddress: policy.poolAddress,
    endpointCodeHash: policy.expectedPoolCodeHash,
    points,
  });
}

export function makeCurveCompositeRoute(policy: CurveMetapoolPolicy) {
  const tokenInPolicy = policy.executionTokens[policy.inputIndex]!;
  const tokenOutPolicy = policy.executionTokens[policy.outputIndex]!;
  const measuredTarget = makeMeasuredTarget({
    stablecoinId: policy.stablecoinId,
    adapterProfileId: policy.adapterProfileId,
    protocol: "curve",
    chain: policy.chain,
    poolId: `${policy.chain}:${policy.poolAddress}`,
    poolTokenAddresses: policy.executionTokens.map((token) => token.address),
    tokenIn: { ...tokenInPolicy, trackedAssetId: policy.stablecoinId, referencePriceUsd: 1 },
    tokenOut: { ...tokenOutPolicy, referencePriceUsd: 1 },
    retainedTvlUsd: 1_000_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
  });
  const points = [1_000, 100_000, 1_000_000].map((inputUsd) => {
    const amountInRaw = BigInt(inputUsd) * 10n ** BigInt(tokenInPolicy.decimals);
    const outputUsd = inputUsd * 0.999;
    const amountOutRaw = BigInt(Math.round(outputUsd * 10 ** tokenOutPolicy.decimals));
    return {
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: encodeCurveCompositeQuote({
        policy,
        inputIndex: policy.inputIndex,
        outputIndex: policy.outputIndex,
        amountInRaw,
      }),
      returnData: `0x${amountOutRaw.toString(16).padStart(64, "0")}` as `0x${string}`,
      inputUsd,
      outputUsd,
      costBps: 10,
      passesCostBound: true,
    };
  });
  return makeRoutePacket(measuredTarget, {
    targetGenerationId: "curve-composite-target-generation",
    quoteGenerationId: "curve-composite-quote-generation",
    endpointAddress: policy.poolAddress,
    endpointCodeHash: policy.expectedPoolCodeHash,
    points,
  });
}

export function makeUniswapV4Route() {
  const deployment = getUniswapV4Deployment("ethereum");
  if (!deployment) throw new Error("missing V4 deployment");
  const poolId = `ethereum:0x${"12".repeat(32)}`;
  const poolTokenAddresses = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ] as const;
  const tokenIn = {
    address: poolTokenAddresses[0],
    symbol: "USDC",
    decimals: 6,
    referencePriceUsd: 1,
    trackedAssetId: "usdc-circle",
  };
  const tokenOut = {
    address: poolTokenAddresses[1],
    symbol: "USDT",
    decimals: 6,
    referencePriceUsd: 1,
    trackedAssetId: "usdt-tether",
  };
  const measuredTarget = makeMeasuredTarget({
    targetId: buildDexMeasuredExecutionTargetId({
      adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID,
      stablecoinId: "usdc-circle",
      chain: "ethereum",
      protocol: "uniswap-v4",
      poolId,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
      poolTokenAddresses,
      feePips: 100,
      tickSpacing: 1,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    }),
    stablecoinId: "usdc-circle",
    adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID,
    protocol: "uniswap-v4",
    chain: "ethereum",
    poolId,
    poolTokenAddresses: [...poolTokenAddresses],
    tokenIn,
    tokenOut,
    feePips: 100,
    tickSpacing: 1,
    hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    retainedTvlUsd: 2_000_000,
    capturedAt: 1_000,
  });
  const points = [1_000, 100_000, 1_000_000].map((inputUsd) => {
    const amountInRaw = BigInt(inputUsd) * 1_000_000n;
    const amountOutRaw = BigInt(Math.round(inputUsd * 0.999 * 1_000_000));
    return {
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: "0x12" as const,
      returnData: "0x12" as const,
      inputUsd,
      outputUsd: inputUsd * 0.999,
      costBps: 10,
      passesCostBound: true,
    };
  });
  return makeRoutePacket(measuredTarget, {
    targetGenerationId: "v4-target-generation",
    quoteGenerationId: "v4-quote-generation",
    endpointAddress: deployment.endpointAddress,
    endpointCodeHash: deployment.expectedCodeHash,
    points,
  });
}

export function makeCurveQuoteRequests(
  target: DexMeasuredExecutionTarget,
  endpointAddress: `0x${string}`,
  blockNumber: number,
  count: number,
  inputUsd: (index: number) => number = (index) => 1_000 + index,
) {
  return Array.from({ length: count }, (_, index) => ({
    target,
    inputUsd: inputUsd(index),
    blockNumber,
    endpointAddress,
  }));
}

export function makeV3Target(options: Partial<Omit<DexMeasuredExecutionTarget, "targetId">> = {}): DexMeasuredExecutionTarget {
  const chain = options.chain ?? "ethereum";
  const input = {
    schemaVersion: "dex-measured-target-v1" as const,
    stablecoinId: "usdc-circle",
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain,
    poolId: `${chain}:0x3333333333333333333333333333333333333333`,
    poolTokenAddresses: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ] as [`0x${string}`, `0x${string}`],
    tokenIn: {
      address: "0x1111111111111111111111111111111111111111" as const,
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    tokenOut: {
      address: "0x2222222222222222222222222222222222222222" as const,
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdt-tether",
    },
    feePips: 100,
    retainedTvlUsd: 100_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
    ...options,
  };
  return {
    ...input,
    targetId: buildDexMeasuredExecutionTargetId({
      adapterProfileId: input.adapterProfileId,
      stablecoinId: input.stablecoinId,
      chain: input.chain,
      protocol: input.protocol,
      poolId: input.poolId,
      tokenInAddress: input.tokenIn.address,
      tokenOutAddress: input.tokenOut.address,
      poolTokenAddresses: input.poolTokenAddresses,
      feePips: input.feePips,
      tickSpacing: input.tickSpacing,
    }),
  };
}
