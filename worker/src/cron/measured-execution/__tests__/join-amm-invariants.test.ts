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
vi.mock("../curve-composite", async () => {
  const actual = await vi.importActual<typeof import("../curve-composite")>(
    "../curve-composite"
  );
  return { ...actual, validateCurveCompositeProfileProof: vi.fn(() => []) };
});
vi.mock("../uniswap-v4", async () => {
  const actual = await vi.importActual<typeof import("../uniswap-v4")>("../uniswap-v4");
  return { ...actual, validateUniswapV4ProfileProof: vi.fn(() => []) };
});

import { buildDexMeasuredExecutionTargetId, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { PoolEntry } from "../../dex-liquidity/types";
import {
  buildDexMeasuredExecutionRetainedRoutePools,
  joinDexMeasuredExecutionEvidence,
} from "../join";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import {
  CURVE_3POOL_STABLESWAP_POLICY,
} from "../curve-stableswap";
import {
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  CURVE_USDG_USDC_STABLESWAP_NG_POLICY,
  encodeCurveStableSwapNgGetDy,
} from "../curve-stableswap-ng";
import {
  makeCurve3PoolPacket,
  makeUniswapV3Target,
} from "./measured-execution.test-support";

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

describe("measured execution join AMM invariants", () => {
  it("keeps an independent exact AMM fallback available after a quote failure", () => {
    const measuredTarget = makeUniswapV3Target();
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
    const { targets, profiles } = makeCurve3PoolPacket();
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
});
