import { describe, expect, it, vi } from "vitest";

vi.mock("../quoter-v2", async () => {
  const actual = await vi.importActual<typeof import("../quoter-v2")>("../quoter-v2");
  return { ...actual, validateQuoterV2ProfileProof: vi.fn(() => []) };
});
vi.mock("../curve-stableswap", async () => {
  const actual = await vi.importActual<typeof import("../curve-stableswap")>("../curve-stableswap");
  return { ...actual, validateCurveStableSwapProfileProof: vi.fn(() => []) };
});
vi.mock("../curve-stableswap-ng", async () => {
  const actual = await vi.importActual<typeof import("../curve-stableswap-ng")>(
    "../curve-stableswap-ng"
  );
  return { ...actual, validateCurveStableSwapNgProfileProof: vi.fn(() => []) };
});

import { buildDexMeasuredExecutionTargetId, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { PoolEntry } from "../../dex-liquidity/types";
import {
  buildDexMeasuredExecutionRetainedRoutePools,
  joinDexMeasuredExecutionEvidence,
  releaseDexMeasuredExecutionProofFields,
  stripDexMeasuredExecutionInternalFields,
} from "../join";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import { getDexMeasuredExecutionDeployment } from "../registry";
import {
  CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  CURVE_CRYPTOSWAP_SHADOW_COHORT,
  encodeCurveCryptoSwapGetDy,
} from "../curve-cryptoswap";
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

function curveStableSwapPacket() {
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

function curveStableSwapNgRoute() {
  const policy = CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
  const poolId = `ethereum:${policy.poolAddress}`;
  const poolTokenAddresses = policy.poolTokens.map((token) => token.address);
  const base = {
    schemaVersion: "dex-measured-target-v1" as const,
    stablecoinId: policy.stablecoinId,
    adapterProfileId: CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
    protocol: "curve",
    chain: policy.chain,
    poolId,
    poolTokenAddresses,
    tokenIn: {
      ...policy.poolTokens[policy.inputIndex],
      referencePriceUsd: 1,
    },
    tokenOut: {
      ...policy.poolTokens[policy.outputIndex],
      referencePriceUsd: 1,
    },
    retainedTvlUsd: 20_501_133,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
  };
  const measuredTarget: DexMeasuredExecutionTarget = {
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
  const profile = buildDexMeasuredExecutionProfile({
    target: measuredTarget,
    targetGenerationId: "curve-ng-target-generation",
    quoteGenerationId: "curve-ng-quote-generation",
    quotedAt: 1_060,
    blockNumber: 25_601_359,
    endpointAddress: policy.poolAddress,
    endpointCodeHash: policy.expectedPoolCodeHash,
    points,
  });
  return { measuredTarget, profile };
}

function target(chain: string = "ethereum"): DexMeasuredExecutionTarget {
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

function slipstreamTarget(): DexMeasuredExecutionTarget {
  const input = {
    schemaVersion: "dex-measured-target-v1" as const,
    stablecoinId: "usdc-circle",
    adapterProfileId: "aerodrome-slipstream-quoter-v2",
    protocol: "aerodrome-slipstream",
    chain: "base",
    poolId: "base:0x3333333333333333333333333333333333333333",
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
    tickSpacing: 1,
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
      tickSpacing: input.tickSpacing,
    }),
  };
}

describe("measured execution join activation", () => {
  it("keeps an independent exact AMM fallback available after a quote failure", () => {
    const measuredTarget = target();
    const pool: PoolEntry = {
      poolId: measuredTarget.poolId,
      project: measuredTarget.protocol,
      chain: measuredTarget.chain,
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "USDC-USDT",
      volumeUsd1d: 10_000,
      poolType: "uniswap-v3",
      source: "dl",
      extra: {
        measuredExecutionTarget: measuredTarget,
        ammExecutionModel: {
          source: "uniswap-v2",
          invariant: "constant-product",
          trackedTokenIndex: 0,
          feeRate: 0.003,
          tokens: [
            {
              ...measuredTarget.tokenIn,
              balance: 1_000_000,
              referencePriceSource: "tracked-market",
            },
            {
              ...measuredTarget.tokenOut,
              balance: 1_000_000,
              referencePriceSource: "tracked-market",
            },
          ],
        },
        executionCapabilityGate: {
          family: "measured-execution",
          reason: "target-unresolved",
        },
      },
    };

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "failed-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([[
          measuredTarget.targetId,
          {
            quotedTarget: measuredTarget,
            status: "failed",
            failureReason: "rpc-failure",
            profile: null,
            quoteGenerationId: "failed-generation",
            targetGenerationId: "target-generation",
            resolution: "latest",
            latestFailureReason: "rpc-failure",
          },
        ]]),
      },
      nowSec: 1_060,
    });

    expect(pool.extra?.measuredExecution).toBeUndefined();
    expect(pool.extra?.ammExecutionModel).toBeDefined();
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(diagnostics).toMatchObject({
      targetCount: 1,
      measuredCount: 0,
      gatedCount: 1,
      failuresByReason: { "uniswap-v3-quoter-v2:quote-failed": 1 },
    });
  });

  it("attaches the reviewed Curve StableSwap directions only as one atomic packet", () => {
    const { targets, profiles } = curveStableSwapPacket();
    const pool: PoolEntry = {
      poolId: "defillama-3pool-row",
      project: "curve",
      chain: "ethereum",
      tvlUsd: 160_000_000,
      symbol: "DAI-USDC-USDT",
      volumeUsd1d: 11_000_000,
      poolType: "curve-stableswap-high-a",
      source: "dl",
      extra: {
        measuredExecutionTargets: targets,
        ammExecutionModel: {
          source: "curve",
          invariant: "stableswap",
          trackedTokenIndex: 2,
          feeRate: 0.001,
          amplification: 4_000 / 9,
          tokens: CURVE_3POOL_STABLESWAP_POLICY.poolTokens.map((token, index) => ({
            ...token,
            balance: 50_000_000,
            referencePriceUsd: 1,
            referencePriceSource: "source-token-usd" as const,
            trackedAssetId: ["dai-makerdao", "usdc-circle", "usdt-tether"][index],
          })),
        },
      },
    };
    const byTargetId = new Map(targets.map((measuredTarget, index) => [
      measuredTarget.targetId,
      {
        quotedTarget: measuredTarget,
        status: "measured" as const,
        failureReason: null,
        profile: profiles[index]!,
        quoteGenerationId: "curve-quote-generation",
        targetGenerationId: "curve-target-generation",
        resolution: "latest" as const,
        latestFailureReason: null,
        observationHistory: {
          completeProducerCycleCount: 2,
          successfulObservationCount: 2,
          consecutiveSuccessCount: 2,
          observationWindowStartedAt: 1_000,
          observationWindowEndedAt: 1_060,
          latestOperationalFailureAt: null,
          conservativeStatistic: "pointwise-minimum" as const,
          conservativeCapacityCurve: profiles[index]!.capacityCurve,
        },
      },
    ]));

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdt-tether", [pool]]]),
      evidence: {
        quoteGenerationId: "curve-quote-generation",
        targetGenerationId: "curve-target-generation",
        publishedAt: 1_060,
        byTargetId,
      },
      nowSec: 1_060 + 7_199,
    });

    expect(pool.extra?.measuredExecutions).toHaveLength(2);
    expect(pool.extra?.measuredExecutionProfiles).toBeUndefined();
    expect(pool.extra?.measuredExecutions?.every(
      (profile) => profile.quotedAt === 1_060 && profile.blockNumber === 25_601_051,
    )).toBe(true);
    expect(pool.extra?.measuredExecutionDiagnostics).toHaveLength(2);
    expect(pool.extra?.ammExecutionModel).toBeDefined();
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(diagnostics).toMatchObject({ targetCount: 2, measuredCount: 2, gatedCount: 0 });

    const releasedPool = { ...pool, extra: { ...pool.extra } };
    releaseDexMeasuredExecutionProofFields([releasedPool]);
    expect(releasedPool.extra?.measuredExecutionTargets).toBeUndefined();
    expect(releasedPool.extra?.measuredExecutionProfiles).toBeUndefined();
    expect(releasedPool.extra?.measuredExecutions).toHaveLength(2);
    expect(releasedPool.extra?.measuredExecutionPhysicalPoolId).toBe(targets[0]!.poolId);

    const expired = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdt-tether", [pool]]]),
      evidence: {
        quoteGenerationId: "curve-quote-generation",
        targetGenerationId: "curve-target-generation",
        publishedAt: 1_060,
        byTargetId,
      },
      nowSec: 1_060 + 7_201,
    });
    expect(pool.extra?.measuredExecutions).toBeUndefined();
    expect(pool.extra?.measuredExecutionProfiles).toBeUndefined();
    expect(pool.extra?.ammExecutionModel).toBeDefined();
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(expired).toMatchObject({ targetCount: 2, measuredCount: 0, gatedCount: 2 });

    stripDexMeasuredExecutionInternalFields([pool]);
    expect(pool.extra?.measuredExecutionTargets).toBeUndefined();
    expect(pool.extra?.measuredExecutions).toBeUndefined();
    expect(pool.extra?.measuredExecutionProfiles).toBeUndefined();
    expect(pool.extra?.ammExecutionModel).toBeDefined();
  });

  it("joins USDG NG evidence without displacing reserves before consumer-side 3/3 maturity", () => {
    const { measuredTarget, profile } = curveStableSwapNgRoute();
    const reserveModel = {
      source: "curve" as const,
      invariant: "stableswap" as const,
      trackedTokenIndex: 0,
      feeRate: 0.001,
      amplification: 1_500,
      tokens: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolTokens.map((token, index) => ({
        ...token,
        balance: index === 0 ? 10_297_747 : 10_203_386,
        referencePriceUsd: 1,
        referencePriceSource: "source-token-usd" as const,
      })),
    };
    const pool: PoolEntry = {
      poolId: "defillama-usdg-ng-row",
      project: "curve",
      chain: "ethereum",
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "USDG-USDC",
      volumeUsd1d: 10_000_000,
      poolType: "curve-stableswap-high-a",
      source: "dl",
      extra: {
        measuredExecutionTarget: measuredTarget,
        ammExecutionModel: reserveModel,
      },
    };
    const quote = (completeCycles: number, successfulCycles: number) => ({
      quotedTarget: measuredTarget,
      status: "measured" as const,
      failureReason: null,
      profile,
      quoteGenerationId: "curve-ng-quote-generation",
      targetGenerationId: "curve-ng-target-generation",
      resolution: "latest" as const,
      latestFailureReason: null,
      observationHistory: {
        completeProducerCycleCount: completeCycles,
        successfulObservationCount: successfulCycles,
        consecutiveSuccessCount: successfulCycles,
        observationWindowStartedAt: 1_000,
        observationWindowEndedAt: 1_060,
        latestOperationalFailureAt: null,
        conservativeStatistic: "pointwise-minimum" as const,
        conservativeCapacityCurve: profile.capacityCurve,
      },
    });

    joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "curve-ng-quote-generation",
        targetGenerationId: "curve-ng-target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([[measuredTarget.targetId, quote(2, 2)]]),
      },
      nowSec: 1_060,
    });
    expect(pool.extra?.measuredExecution?.observationHistory).toMatchObject({
      completeProducerCycleCount: 2,
      successfulObservationCount: 2,
    });
    expect(pool.extra?.ammExecutionModel).toBe(reserveModel);
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();

    const failedPool: PoolEntry = {
      ...pool,
      extra: { measuredExecutionTarget: measuredTarget, ammExecutionModel: reserveModel },
    };
    joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [failedPool]]]),
      evidence: {
        quoteGenerationId: "failed-generation",
        targetGenerationId: "curve-ng-target-generation",
        publishedAt: 1_090,
        byTargetId: new Map([[
          measuredTarget.targetId,
          {
            quotedTarget: measuredTarget,
            status: "failed",
            failureReason: "factory-code-hash-mismatch",
            profile: null,
            quoteGenerationId: "failed-generation",
            targetGenerationId: "curve-ng-target-generation",
            resolution: "latest",
            latestFailureReason: "factory-code-hash-mismatch",
          },
        ]]),
      },
      nowSec: 1_090,
    });
    expect(failedPool.extra?.measuredExecution).toBeUndefined();
    expect(failedPool.extra?.executionCapabilityGate).toBeUndefined();
    expect(failedPool.extra?.ammExecutionModel).toBe(reserveModel);

    const retainedEvidence = {
      quoteGenerationId: "latest-operational-failure",
      targetGenerationId: "latest-target-generation",
      publishedAt: 1_090,
      byTargetId: new Map([[
        measuredTarget.targetId,
        {
          ...quote(3, 3),
          resolution: "last-known-good" as const,
          latestFailureReason: "factory-code-unavailable",
        },
      ]]),
    };
    const retained = buildDexMeasuredExecutionRetainedRoutePools({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, []]]),
      evidence: retainedEvidence,
      nowSec: 1_090,
    });
    expect(retained.get(measuredTarget.stablecoinId)?.[0]).toMatchObject({
      poolId: measuredTarget.poolId,
      poolType: "curve-stableswap-ng-measured-retained",
      source: "dl",
      extra: {
        measuredExecution: {
          adapterProfileId: CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
          observationHistory: {
            completeProducerCycleCount: 3,
            successfulObservationCount: 3,
          },
        },
      },
    });

    retainedEvidence.byTargetId.set(measuredTarget.targetId, {
      ...quote(3, 2),
      resolution: "last-known-good",
      latestFailureReason: "factory-code-unavailable",
    });
    expect(buildDexMeasuredExecutionRetainedRoutePools({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, []]]),
      evidence: retainedEvidence,
      nowSec: 1_090,
    }).size).toBe(0);
  });

  it("keeps reserve evidence available when one StableSwap direction is missing", () => {
    const { targets, profiles } = curveStableSwapPacket();
    const pool: PoolEntry = {
      poolId: "defillama-3pool-row",
      project: "curve",
      chain: "ethereum",
      tvlUsd: 160_000_000,
      symbol: "DAI-USDC-USDT",
      volumeUsd1d: 11_000_000,
      poolType: "curve-stableswap-high-a",
      source: "dl",
      extra: {
        measuredExecutionTargets: targets,
        ammExecutionModel: {
          source: "curve",
          invariant: "stableswap",
          trackedTokenIndex: 2,
          feeRate: 0.001,
          amplification: 4_000 / 9,
          tokens: CURVE_3POOL_STABLESWAP_POLICY.poolTokens.map((token, index) => ({
            ...token,
            balance: 50_000_000,
            referencePriceUsd: 1,
            referencePriceSource: "source-token-usd" as const,
            trackedAssetId: ["dai-makerdao", "usdc-circle", "usdt-tether"][index],
          })),
        },
      },
    };
    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdt-tether", [pool]]]),
      evidence: {
        quoteGenerationId: "curve-quote-generation",
        targetGenerationId: "curve-target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([[
          targets[0]!.targetId,
          {
            quotedTarget: targets[0]!,
            status: "measured",
            failureReason: null,
            profile: profiles[0]!,
            quoteGenerationId: "curve-quote-generation",
            targetGenerationId: "curve-target-generation",
            resolution: "latest",
            latestFailureReason: null,
          },
        ]]),
      },
      nowSec: 1_060,
    });

    expect(pool.extra?.measuredExecutions).toBeUndefined();
    expect(pool.extra?.measuredExecutionProfiles).toBeUndefined();
    expect(pool.extra?.ammExecutionModel).toBeDefined();
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(pool.extra?.measuredExecutionDiagnostics?.every(
      (diagnostic) => diagnostic.detail === "atomic-direction-missing",
    )).toBe(true);
    expect(diagnostics).toMatchObject({ targetCount: 2, measuredCount: 0, gatedCount: 2 });
  });

  it("retains a mature StableSwap LKG only when both historical siblings validate", () => {
    const { targets, profiles } = curveStableSwapPacket();
    const byTargetId = new Map(targets.map((measuredTarget, index) => [
      measuredTarget.targetId,
      {
        quotedTarget: measuredTarget,
        status: "measured" as const,
        failureReason: null,
        profile: profiles[index]!,
        quoteGenerationId: "curve-quote-generation",
        targetGenerationId: "curve-target-generation",
        resolution: "last-known-good" as const,
        latestFailureReason: "rpc-failure",
        observationHistory: {
          completeProducerCycleCount: 3,
          successfulObservationCount: 3,
          consecutiveSuccessCount: 2,
          observationWindowStartedAt: 1_000,
          observationWindowEndedAt: 1_060,
          latestOperationalFailureAt: 1_060,
          conservativeStatistic: "pointwise-minimum" as const,
          conservativeCapacityCurve: profiles[index]!.capacityCurve,
        },
      },
    ]));
    const evidence = {
      quoteGenerationId: "latest-operational-failure",
      targetGenerationId: "latest-target-generation",
      publishedAt: 1_120,
      byTargetId,
    };

    const retained = buildDexMeasuredExecutionRetainedRoutePools({
      poolsByStablecoin: new Map([["usdt-tether", []]]),
      evidence,
      nowSec: 1_060 + 3_600,
    });

    expect(retained.get("usdt-tether")).toEqual([
      expect.objectContaining({
        poolId: `ethereum:${CURVE_3POOL_STABLESWAP_POLICY.poolAddress}`,
        poolType: "curve-stableswap-measured-retained",
        source: "dl",
        extra: expect.objectContaining({
          measuredExecutionTargets: expect.arrayContaining(targets),
          measuredExecutions: expect.arrayContaining([
            expect.objectContaining({ targetId: targets[0]!.targetId }),
            expect.objectContaining({ targetId: targets[1]!.targetId }),
          ]),
        }),
      }),
    ]);
    expect(retained.get("usdt-tether")?.[0]?.extra?.measuredExecutionProfiles).toBeUndefined();

    const partial = buildDexMeasuredExecutionRetainedRoutePools({
      poolsByStablecoin: new Map([["usdt-tether", []]]),
      evidence: {
        ...evidence,
        byTargetId: new Map([[targets[0]!.targetId, byTargetId.get(targets[0]!.targetId)!]]),
      },
      nowSec: 1_060 + 3_600,
    });
    expect(partial.get("usdt-tether")).toBeUndefined();

    const currentPhysicalPool = buildDexMeasuredExecutionRetainedRoutePools({
      poolsByStablecoin: new Map([["usdt-tether", [{
        poolId: "defillama-yields-uuid",
        project: "curve",
        chain: "ethereum",
        tvlUsd: 160_047_206,
        symbol: "USDT-DAI-USDC",
        volumeUsd1d: 0,
        poolType: "curve-stableswap",
        source: "dl",
        extra: {
          measuredExecutionPhysicalPoolId:
            `ethereum:${CURVE_3POOL_STABLESWAP_POLICY.poolAddress}`,
        },
      }]]]),
      evidence,
      nowSec: 1_060 + 3_600,
    });
    expect(currentPhysicalPool.get("usdt-tether")).toBeUndefined();
  });

  it("admits a valid Optimism Uniswap V3 profile after ratification", () => {
    const measuredTarget = target("optimism");
    const deployment = getDexMeasuredExecutionDeployment(measuredTarget.adapterProfileId, measuredTarget.chain);
    if (deployment == null) throw new Error("missing Optimism QuoterV2 deployment");
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: 1_060,
      blockNumber: 25_536_894,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [
        {
          amountInRaw: "1000000000",
          amountOutRaw: "999000000",
          callData: "0x01",
          returnData: "0x01",
          inputUsd: 1_000,
          outputUsd: 999,
          costBps: 10,
          passesCostBound: true,
        },
        {
          amountInRaw: "100000000000",
          amountOutRaw: "99900000000",
          callData: "0x02",
          returnData: "0x02",
          inputUsd: 100_000,
          outputUsd: 99_900,
          costBps: 10,
          passesCostBound: true,
        },
      ],
    });
    const pool: PoolEntry = {
      poolId: measuredTarget.poolId,
      project: measuredTarget.protocol,
      chain: measuredTarget.chain,
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "USDC-USDT",
      volumeUsd1d: 0,
      poolType: "uniswap-v3-1bp",
      source: "dl",
      extra: { measuredExecutionTarget: measuredTarget },
    };

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([
          [
            measuredTarget.targetId,
            {
              quotedTarget: measuredTarget,
              status: "measured",
              failureReason: null,
              profile,
              quoteGenerationId: "quote-generation",
              targetGenerationId: "target-generation",
              resolution: "latest",
              latestFailureReason: null,
            },
          ],
        ]),
      },
      nowSec: 1_060,
    });

    expect(pool.extra?.measuredExecution).toBeDefined();
    expect(pool.extra?.measuredExecution).not.toHaveProperty("quoteProof");
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(diagnostics).toMatchObject({ measuredCount: 1, gatedCount: 0 });
  });

  it("admits a valid Base Aerodrome Slipstream profile after activation", () => {
    const measuredTarget = slipstreamTarget();
    const deployment = getDexMeasuredExecutionDeployment(measuredTarget.adapterProfileId, measuredTarget.chain);
    if (deployment == null) throw new Error("missing Base Slipstream deployment");
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: 1_060,
      blockNumber: 49_039_054,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [
        {
          amountInRaw: "1000000000",
          amountOutRaw: "999000000",
          callData: "0x01",
          returnData: "0x01",
          inputUsd: 1_000,
          outputUsd: 999,
          costBps: 10,
          passesCostBound: true,
        },
        {
          amountInRaw: "100000000000",
          amountOutRaw: "99900000000",
          callData: "0x02",
          returnData: "0x02",
          inputUsd: 100_000,
          outputUsd: 99_900,
          costBps: 10,
          passesCostBound: true,
        },
      ],
    });
    const pool: PoolEntry = {
      poolId: measuredTarget.poolId,
      project: measuredTarget.protocol,
      chain: measuredTarget.chain,
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "USDC-USDT",
      volumeUsd1d: 0,
      poolType: "aerodrome-slipstream-1bp",
      source: "direct_api",
      extra: { measuredExecutionTarget: measuredTarget },
    };

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([
          [
            measuredTarget.targetId,
            {
              quotedTarget: measuredTarget,
              status: "measured",
              failureReason: null,
              profile,
              quoteGenerationId: "quote-generation",
              targetGenerationId: "target-generation",
              resolution: "latest",
              latestFailureReason: null,
            },
          ],
        ]),
      },
      nowSec: 1_060,
    });

    expect(pool.extra?.measuredExecution).toBeDefined();
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(diagnostics).toMatchObject({ measuredCount: 1, gatedCount: 0 });

    const retained = buildDexMeasuredExecutionRetainedRoutePools({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, []]]),
      evidence: {
        quoteGenerationId: "quote-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([
          [
            measuredTarget.targetId,
            {
              quotedTarget: measuredTarget,
              status: "measured",
              failureReason: null,
              profile,
              quoteGenerationId: "quote-generation",
              targetGenerationId: "target-generation",
              resolution: "last-known-good",
              latestFailureReason: "quote-missing",
              observationHistory: {
                completeProducerCycleCount: 2,
                successfulObservationCount: 2,
                consecutiveSuccessCount: 2,
                observationWindowStartedAt: 1_000,
                observationWindowEndedAt: 1_060,
                latestOperationalFailureAt: null,
                conservativeStatistic: "pointwise-minimum",
                conservativeCapacityCurve: profile.capacityCurve,
              },
            },
          ],
        ]),
      },
      nowSec: 1_060,
    });
    expect(retained.get(measuredTarget.stablecoinId)?.[0]).toMatchObject({
      project: "aerodrome-slipstream",
      poolType: "aerodrome-slipstream-measured-retained",
      source: "direct_api",
    });
  });

  it("admits a fresh last-known-good profile with its original generation identity and quote clock", () => {
    const measuredTarget = target();
    const deployment = getDexMeasuredExecutionDeployment(measuredTarget.adapterProfileId, measuredTarget.chain);
    if (deployment == null) throw new Error("missing Ethereum QuoterV2 deployment");
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_060,
      blockNumber: 25_536_894,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [
        {
          amountInRaw: "1000000000",
          amountOutRaw: "970000000",
          callData: "0x01",
          returnData: "0x01",
          inputUsd: 1_000,
          outputUsd: 970,
          costBps: 300,
          passesCostBound: false,
        },
      ],
    });
    const currentTarget = { ...measuredTarget, capturedAt: 2_000 };
    const pool: PoolEntry = {
      poolId: currentTarget.poolId,
      project: currentTarget.protocol,
      chain: currentTarget.chain,
      tvlUsd: currentTarget.retainedTvlUsd,
      symbol: "USDC-USDT",
      volumeUsd1d: 0,
      poolType: "uniswap-v3-1bp",
      source: "dl",
      extra: { measuredExecutionTarget: currentTarget },
    };

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[currentTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation-latest",
        targetGenerationId: "target-generation-latest",
        publishedAt: 2_000,
        byTargetId: new Map([
          [
            currentTarget.targetId,
            {
              quotedTarget: measuredTarget,
              status: "measured",
              failureReason: null,
              profile,
              quoteGenerationId: "quote-generation-lkg",
              targetGenerationId: "target-generation-lkg",
              resolution: "last-known-good",
              latestFailureReason: "request-budget-exhausted",
              observationHistory: {
                completeProducerCycleCount: 3,
                successfulObservationCount: 2,
                consecutiveSuccessCount: 0,
                observationWindowStartedAt: 1_000,
                observationWindowEndedAt: 2_000,
                latestOperationalFailureAt: 2_000,
                conservativeStatistic: "pointwise-minimum",
                conservativeCapacityCurve: profile.capacityCurve,
              },
            },
          ],
        ]),
      },
      nowSec: 4_600,
    });

    expect(pool.extra?.measuredExecution?.quotedAt).toBe(1_060);
    expect(pool.extra?.measuredExecution?.observationHistory).toMatchObject({
      successfulObservationCount: 2,
      latestOperationalFailureAt: 2_000,
    });
    expect(pool.extra?.measuredExecutionDiagnostic?.detail).toBe(
      "last-known-good-after:request-budget-exhausted",
    );
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(diagnostics).toMatchObject({ measuredCount: 1, lastKnownGoodCount: 1, gatedCount: 0 });
  });

  it("retains a mature last-known-good route when its pool rotates out of the current shortlist", () => {
    const measuredTarget = target();
    const deployment = getDexMeasuredExecutionDeployment(measuredTarget.adapterProfileId, measuredTarget.chain);
    if (deployment == null) throw new Error("missing Ethereum QuoterV2 deployment");
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_060,
      blockNumber: 25_536_894,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [
        {
          amountInRaw: "1000000000",
          amountOutRaw: "999000000",
          callData: "0x01",
          returnData: "0x01",
          inputUsd: 1_000,
          outputUsd: 999,
          costBps: 10,
          passesCostBound: true,
        },
        {
          amountInRaw: "100000000000",
          amountOutRaw: "99900000000",
          callData: "0x02",
          returnData: "0x02",
          inputUsd: 100_000,
          outputUsd: 99_900,
          costBps: 10,
          passesCostBound: true,
        },
      ],
    });
    const evidence = {
      quoteGenerationId: "quote-generation-latest",
      targetGenerationId: "target-generation-latest",
      publishedAt: 2_000,
      byTargetId: new Map([
        [
          measuredTarget.targetId,
          {
            quotedTarget: measuredTarget,
            status: "measured" as const,
            failureReason: null,
            profile,
            quoteGenerationId: "quote-generation-lkg",
            targetGenerationId: "target-generation-lkg",
            resolution: "last-known-good" as const,
            latestFailureReason: "quote-missing",
            observationHistory: {
              completeProducerCycleCount: 3,
              successfulObservationCount: 2,
              consecutiveSuccessCount: 2,
              observationWindowStartedAt: 1_000,
              observationWindowEndedAt: 2_000,
              latestOperationalFailureAt: null,
              conservativeStatistic: "pointwise-minimum" as const,
              conservativeCapacityCurve: profile.capacityCurve,
            },
          },
        ],
      ]),
    };

    const retained = buildDexMeasuredExecutionRetainedRoutePools({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, []]]),
      evidence,
      nowSec: 2_000,
    });

    expect(retained.get(measuredTarget.stablecoinId)).toEqual([
      expect.objectContaining({
        poolId: measuredTarget.poolId,
        project: "uniswap-v3",
        source: "dl",
        extra: expect.objectContaining({
          measuredExecutionPhysicalPoolId: measuredTarget.poolId,
          measuredExecution: expect.objectContaining({
            targetId: measuredTarget.targetId,
            observationHistory: expect.objectContaining({ successfulObservationCount: 2 }),
          }),
        }),
      }),
    ]);
  });

  it("does not retain an immature, stale, or still-current measured route", () => {
    const measuredTarget = target();
    const deployment = getDexMeasuredExecutionDeployment(measuredTarget.adapterProfileId, measuredTarget.chain);
    if (deployment == null) throw new Error("missing Ethereum QuoterV2 deployment");
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_060,
      blockNumber: 25_536_894,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [
        {
          amountInRaw: "1000000000",
          amountOutRaw: "999000000",
          callData: "0x01",
          returnData: "0x01",
          inputUsd: 1_000,
          outputUsd: 999,
          costBps: 10,
          passesCostBound: true,
        },
      ],
    });
    const quote = {
      quotedTarget: measuredTarget,
      status: "measured" as const,
      failureReason: null,
      profile,
      quoteGenerationId: "quote-generation-lkg",
      targetGenerationId: "target-generation-lkg",
      resolution: "last-known-good" as const,
      latestFailureReason: "quote-missing",
      observationHistory: {
        completeProducerCycleCount: 1,
        successfulObservationCount: 1,
        consecutiveSuccessCount: 1,
        observationWindowStartedAt: 1_060,
        observationWindowEndedAt: 1_060,
        latestOperationalFailureAt: null,
        conservativeStatistic: "pointwise-minimum" as const,
        conservativeCapacityCurve: profile.capacityCurve,
      },
    };
    const evidence = {
      quoteGenerationId: "quote-generation-latest",
      targetGenerationId: "target-generation-latest",
      publishedAt: 2_000,
      byTargetId: new Map([[measuredTarget.targetId, quote]]),
    };
    const currentPool: PoolEntry = {
      poolId: measuredTarget.poolId,
      project: measuredTarget.protocol,
      chain: measuredTarget.chain,
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "USDC-USDT",
      volumeUsd1d: 0,
      poolType: "uniswap-v3-1bp",
      source: "dl",
      extra: { measuredExecutionTarget: measuredTarget },
    };

    expect(
      buildDexMeasuredExecutionRetainedRoutePools({
        poolsByStablecoin: new Map([[measuredTarget.stablecoinId, []]]),
        evidence,
        nowSec: 2_000,
      }).size,
    ).toBe(0);
    quote.observationHistory.successfulObservationCount = 2;
    const currentEvidence = {
      ...evidence,
      byTargetId: new Map([
        [
          measuredTarget.targetId,
          {
            ...quote,
            profile: null,
            deferredProfileJson: "not-json",
          },
        ],
      ]),
    };
    expect(
      buildDexMeasuredExecutionRetainedRoutePools({
        poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [currentPool]]]),
        evidence: currentEvidence,
        nowSec: 2_000,
      }).size,
    ).toBe(0);
    expect(
      buildDexMeasuredExecutionRetainedRoutePools({
        poolsByStablecoin: new Map([[measuredTarget.stablecoinId, []]]),
        evidence,
        nowSec: 4_661,
      }).size,
    ).toBe(0);
  });

  it("rejects a last-known-good profile once its original quote clock is stale", () => {
    const measuredTarget = target();
    const deployment = getDexMeasuredExecutionDeployment(measuredTarget.adapterProfileId, measuredTarget.chain);
    if (deployment == null) throw new Error("missing Ethereum QuoterV2 deployment");
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_060,
      blockNumber: 25_536_894,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [
        {
          amountInRaw: "1000000000",
          amountOutRaw: "970000000",
          callData: "0x01",
          returnData: "0x01",
          inputUsd: 1_000,
          outputUsd: 970,
          costBps: 300,
          passesCostBound: false,
        },
      ],
    });
    const pool: PoolEntry = {
      poolId: measuredTarget.poolId,
      project: measuredTarget.protocol,
      chain: measuredTarget.chain,
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "USDC-USDT",
      volumeUsd1d: 0,
      poolType: "uniswap-v3-1bp",
      source: "dl",
      extra: { measuredExecutionTarget: measuredTarget },
    };

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation-latest",
        targetGenerationId: "target-generation-latest",
        publishedAt: 2_000,
        byTargetId: new Map([
          [
            measuredTarget.targetId,
            {
              quotedTarget: measuredTarget,
              status: "measured",
              failureReason: null,
              profile,
              quoteGenerationId: "quote-generation-lkg",
              targetGenerationId: "target-generation-lkg",
              resolution: "last-known-good",
              latestFailureReason: "quoter-rpc-unavailable",
            },
          ],
        ]),
      },
      nowSec: 4_661,
    });

    expect(pool.extra?.measuredExecution).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "measured-execution",
      reason: "stale-observation",
    });
    expect(diagnostics).toMatchObject({ measuredCount: 0, lastKnownGoodCount: 0, gatedCount: 1 });
  });

  it("admits a valid proof from an active Curve CryptoSwap pool", () => {
    const policy = CURVE_CRYPTOSWAP_SHADOW_COHORT.find(
      (entry) => entry.poolAddress === "0x6e5492f8ea2370844ee098a56dd88e1717e4a9c2",
    );
    if (!policy?.expectedPoolCodeHash) throw new Error("missing active Curve policy");
    const amountInRaw = 1_000n * 10n ** 18n;
    const amountOutRaw = 400_000_000_000_000_000n;
    const tokenAddresses = [
      "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    ] as [`0x${string}`, `0x${string}`];
    const input = {
      schemaVersion: "dex-measured-target-v1" as const,
      stablecoinId: "crvusd-curve",
      adapterProfileId: CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
      protocol: "curve",
      chain: "ethereum",
      poolId: `ethereum:${policy.poolAddress}`,
      poolTokenAddresses: tokenAddresses,
      tokenIn: {
        address: tokenAddresses[0],
        symbol: "crvUSD",
        decimals: 18,
        referencePriceUsd: 1,
        trackedAssetId: "crvusd-curve",
      },
      tokenOut: {
        address: tokenAddresses[1],
        symbol: "WETH",
        decimals: 18,
        referencePriceUsd: 2_500,
      },
      retainedTvlUsd: 100_000,
      retainedPoolPriceUsd: 1,
      capturedAt: 1_000,
    };
    const measuredTarget: DexMeasuredExecutionTarget = {
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
      }),
    };
    const callData = encodeCurveCryptoSwapGetDy({ inputIndex: 0, outputIndex: 1, amountInRaw });
    const returnData = `0x${amountOutRaw.toString(16).padStart(64, "0")}` as `0x${string}`;
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: 1_060,
      blockNumber: 25_550_158,
      endpointAddress: policy.poolAddress,
      endpointCodeHash: policy.expectedPoolCodeHash,
      points: [
        {
          amountInRaw: amountInRaw.toString(),
          amountOutRaw: amountOutRaw.toString(),
          callData,
          returnData,
          inputUsd: 1_000,
          outputUsd: 1_000,
          costBps: 0,
          passesCostBound: true,
        },
        {
          amountInRaw: (100_000n * 10n ** 18n).toString(),
          amountOutRaw: (40n * 10n ** 18n).toString(),
          callData: encodeCurveCryptoSwapGetDy({
            inputIndex: 0,
            outputIndex: 1,
            amountInRaw: 100_000n * 10n ** 18n,
          }),
          returnData: `0x${(40n * 10n ** 18n).toString(16).padStart(64, "0")}`,
          inputUsd: 100_000,
          outputUsd: 100_000,
          costBps: 0,
          passesCostBound: true,
        },
      ],
    });
    const pool: PoolEntry = {
      poolId: measuredTarget.poolId,
      project: "curve",
      chain: "ethereum",
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "crvUSD-WETH",
      volumeUsd1d: 0,
      poolType: "curve-cryptoswap",
      source: "dl",
      extra: {
        measuredExecutionTarget: measuredTarget,
        executionCapabilityGate: { family: "measured-execution", reason: "target-unresolved" },
      },
    };

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([[measuredTarget.targetId, {
          quotedTarget: measuredTarget,
          status: "measured",
          failureReason: null,
          profile,
          quoteGenerationId: "quote-generation",
          targetGenerationId: "target-generation",
          resolution: "latest",
          latestFailureReason: null,
        }]]),
      },
      nowSec: 1_060,
    });

    expect(diagnostics).toMatchObject({ measuredCount: 1, gatedCount: 0 });
    expect(pool.extra?.measuredExecution).toBeDefined();
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
  });
});
