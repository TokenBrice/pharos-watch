import {
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import {
  CURVE_3POOL_STABLESWAP_POLICY,
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
  encodeCurveStableSwapGetDy,
} from "../curve-stableswap";

export function makeCurve3PoolPacket() {
  const policy = CURVE_3POOL_STABLESWAP_POLICY;
  const stablecoinIds = ["dai-makerdao", "usdc-circle", "usdt-tether"];
  const inputIndex = 2;
  const poolId = `ethereum:${policy.poolAddress}`;
  const targets = [0, 1].map((outputIndex): DexMeasuredExecutionTarget => {
    const tokenInPolicy = policy.poolTokens[inputIndex]!;
    const tokenOutPolicy = policy.poolTokens[outputIndex]!;
    const poolTokenAddresses = policy.poolTokens.map((token) => token.address);
    const base = {
      schemaVersion: "dex-measured-target-v1" as const,
      stablecoinId: "usdt-tether",
      adapterProfileId: CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
      protocol: "curve",
      chain: "ethereum",
      poolId,
      poolTokenAddresses,
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
        poolTokenAddresses,
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

export function makeUniswapV3Target(options: { chain?: string } = {}): DexMeasuredExecutionTarget {
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
    }),
  };
}
