import { describe, expect, it, vi } from "vitest";

vi.mock("../quoter-v2", async () => {
  const actual = await vi.importActual<typeof import("../quoter-v2")>("../quoter-v2");
  return { ...actual, validateQuoterV2ProfileProof: vi.fn(() => []) };
});
vi.mock("../curve-stableswap", async () => {
  const actual = await vi.importActual<typeof import("../curve-stableswap")>("../curve-stableswap");
  return { ...actual, validateCurveStableSwapProfileProof: vi.fn(() => []) };
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
} from "../curve-stableswap";
import {
  CURVE_NXUSD_METAPOOL_POLICY,
  CURVE_R3_METAPOOL_POLICIES,
  CURVE_USD1_METAPOOL_POLICY,
  encodeCurveCompositeQuote,
  type CurveMetapoolPolicy,
} from "../curve-composite";
import {
  UNISWAP_V4_ADAPTER_PROFILE_ID,
  UNISWAP_V4_HOOK_FREE_ADDRESS,
  getUniswapV4Deployment,
} from "../uniswap-v4";
import { makeCurve3PoolPacket, makeUniswapV3Target } from "./measured-execution.test-support";

function curveCompositeRoute(policy: CurveMetapoolPolicy) {
  const poolId = `${policy.chain}:${policy.poolAddress}`;
  const poolTokenAddresses = policy.executionTokens.map((token) => token.address);
  const tokenInPolicy = policy.executionTokens[policy.inputIndex]!;
  const tokenOutPolicy = policy.executionTokens[policy.outputIndex]!;
  const base = {
    schemaVersion: "dex-measured-target-v1" as const,
    stablecoinId: policy.stablecoinId,
    adapterProfileId: policy.adapterProfileId,
    protocol: "curve",
    chain: policy.chain,
    poolId,
    poolTokenAddresses,
    tokenIn: {
      ...tokenInPolicy,
      trackedAssetId: policy.stablecoinId,
      referencePriceUsd: 1,
    },
    tokenOut: {
      ...tokenOutPolicy,
      referencePriceUsd: 1,
    },
    retainedTvlUsd: 1_000_000,
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
  const profile = buildDexMeasuredExecutionProfile({
    target: measuredTarget,
    targetGenerationId: "curve-composite-target-generation",
    quoteGenerationId: "curve-composite-quote-generation",
    quotedAt: 1_060,
    blockNumber: 25_601_359,
    endpointAddress: policy.poolAddress,
    endpointCodeHash: policy.expectedPoolCodeHash,
    points,
  });
  return { measuredTarget, profile };
}

function uniswapV4Route() {
  const deployment = getUniswapV4Deployment("ethereum");
  if (!deployment) throw new Error("missing V4 deployment");
  const poolId = `ethereum:0x${"12".repeat(32)}`;
  const poolTokenAddresses = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ] as [`0x${string}`, `0x${string}`];
  const input = {
    schemaVersion: "dex-measured-target-v1" as const,
    stablecoinId: "usdc-circle",
    adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID,
    protocol: "uniswap-v4",
    chain: "ethereum",
    poolId,
    poolTokenAddresses,
    tokenIn: {
      address: poolTokenAddresses[0],
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    tokenOut: {
      address: poolTokenAddresses[1],
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdt-tether",
    },
    feePips: 100,
    tickSpacing: 1,
    hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    retainedTvlUsd: 2_000_000,
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
      poolTokenAddresses,
      feePips: input.feePips,
      tickSpacing: input.tickSpacing,
      hookAddress: input.hookAddress,
    }),
  };
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
  const profile = buildDexMeasuredExecutionProfile({
    target: measuredTarget,
    targetGenerationId: "v4-target-generation",
    quoteGenerationId: "v4-quote-generation",
    quotedAt: 1_060,
    blockNumber: 25_601_359,
    endpointAddress: deployment.endpointAddress,
    endpointCodeHash: deployment.expectedCodeHash,
    points,
  });
  return { measuredTarget, profile };
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
  it("joins reviewed hook-free Ethereum V4 evidence without an activation gate", () => {
    const { measuredTarget, profile } = uniswapV4Route();
    const pool: PoolEntry = {
      poolId: measuredTarget.poolId,
      project: "uniswap-v4",
      chain: "ethereum",
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "USDC-USDT",
      volumeUsd1d: 10_000,
      poolType: "uniswap-v4",
      source: "dl",
      extra: { measuredExecutionTarget: measuredTarget },
    };
    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "v4-quote-generation",
        targetGenerationId: "v4-target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([[measuredTarget.targetId, {
          quotedTarget: measuredTarget,
          status: "measured",
          failureReason: null,
          profile,
          quoteGenerationId: "v4-quote-generation",
          targetGenerationId: "v4-target-generation",
          resolution: "latest",
          latestFailureReason: null,
        }]]),
      },
      nowSec: 1_060,
    });

    expect(pool.extra?.measuredExecutionDiagnostic?.detail).toBeUndefined();
    expect(pool.extra?.measuredExecution).toMatchObject({
      adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID,
    });
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(diagnostics).toMatchObject({ targetCount: 1, measuredCount: 1, gatedCount: 0 });
  });

  it("makes all nine reviewed metapool quotes score eligible without an activation gate", () => {
    for (const policy of CURVE_R3_METAPOOL_POLICIES) {
      const { measuredTarget, profile } = curveCompositeRoute(policy);
      const pool: PoolEntry = {
        poolId: measuredTarget.poolId,
        project: "curve",
        chain: policy.chain,
        tvlUsd: measuredTarget.retainedTvlUsd,
        symbol: `${measuredTarget.tokenIn.symbol}-${measuredTarget.tokenOut.symbol}`,
        volumeUsd1d: 10_000,
        poolType: "curve-metapool",
        source: "dl",
        extra: { measuredExecutionTarget: measuredTarget },
      };
      const diagnostics = joinDexMeasuredExecutionEvidence({
        poolsByStablecoin: new Map([[policy.stablecoinId, [pool]]]),
        evidence: {
          quoteGenerationId: "curve-composite-quote-generation",
          targetGenerationId: "curve-composite-target-generation",
          publishedAt: 1_060,
          byTargetId: new Map([[
            measuredTarget.targetId,
            {
              quotedTarget: measuredTarget,
              status: "measured",
              failureReason: null,
              profile,
              quoteGenerationId: "curve-composite-quote-generation",
              targetGenerationId: "curve-composite-target-generation",
              resolution: "latest",
              latestFailureReason: null,
            },
          ]]),
        },
        nowSec: 1_060,
      });

      expect(pool.extra?.measuredExecution).toMatchObject({
        targetId: measuredTarget.targetId,
        adapterProfileId: policy.adapterProfileId,
      });
      expect(pool.extra?.executionCapabilityGate).toBeUndefined();
      expect(pool.extra?.measuredExecutionDiagnostic?.detail).not.toBe("activation-pending");
      expect(diagnostics).toMatchObject({ targetCount: 1, measuredCount: 1, gatedCount: 0 });
    }
  });

  it("keeps the reviewed USD1 and NXUSD metapool adapters shadow-only", () => {
    for (const policy of [CURVE_USD1_METAPOOL_POLICY, CURVE_NXUSD_METAPOOL_POLICY]) {
      const { measuredTarget, profile } = curveCompositeRoute(policy);
      const pool: PoolEntry = {
        poolId: measuredTarget.poolId,
        project: "curve",
        chain: policy.chain,
        tvlUsd: measuredTarget.retainedTvlUsd,
        symbol: `${measuredTarget.tokenIn.symbol}-${measuredTarget.tokenOut.symbol}`,
        volumeUsd1d: 10_000,
        poolType: "curve-metapool",
        source: "dl",
        extra: { measuredExecutionTarget: measuredTarget },
      };
      const diagnostics = joinDexMeasuredExecutionEvidence({
        poolsByStablecoin: new Map([[policy.stablecoinId, [pool]]]),
        evidence: {
          quoteGenerationId: "curve-composite-quote-generation",
          targetGenerationId: "curve-composite-target-generation",
          publishedAt: 1_060,
          byTargetId: new Map([[
            measuredTarget.targetId,
            {
              quotedTarget: measuredTarget,
              status: "measured",
              failureReason: null,
              profile,
              quoteGenerationId: "curve-composite-quote-generation",
              targetGenerationId: "curve-composite-target-generation",
              resolution: "latest",
              latestFailureReason: null,
            },
          ]]),
        },
        nowSec: 1_060,
      });

      expect(pool.extra?.measuredExecution).toMatchObject({
        targetId: measuredTarget.targetId,
        adapterProfileId: policy.adapterProfileId,
      });
      expect(pool.extra?.executionCapabilityGate).toEqual({
        family: "measured-execution",
        reason: "activation-pending",
      });
      expect(pool.extra?.measuredExecutionDiagnostic?.detail).toContain(
        "shadow-score-ineligible",
      );
      expect(diagnostics).toMatchObject({ targetCount: 1, measuredCount: 1, gatedCount: 1 });
    }
  });

  it("attaches the reviewed Curve StableSwap directions only as one atomic packet", () => {
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
      nowSec: 1_060 + 10_799,
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
      nowSec: 1_060 + 10_801,
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

  it("retains a mature StableSwap LKG only when both historical siblings validate", () => {
    const { targets, profiles } = makeCurve3PoolPacket();
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

  it("drops retired Optimism Uniswap V3 profiles at deployment validation", () => {
    const measuredTarget = makeUniswapV3Target({ chain: "optimism" });
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: 1_060,
      blockNumber: 25_536_894,
      endpointAddress: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
      endpointCodeHash: "0xd833dcf44a912014423afa2b637f23b5db5b7dc492494cbe3f46026a6d57b424",
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

    expect(pool.extra?.measuredExecution).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "measured-execution",
      reason: "deployment-code-mismatch",
    });
    expect(pool.extra?.measuredExecutionDiagnostic).toMatchObject({
      adapterProfileId: "uniswap-v3-quoter-v2",
      detail: "deployment-missing",
    });
    expect(diagnostics).toMatchObject({
      targetCount: 1,
      gatedCount: 1,
      failuresByReason: { "uniswap-v3-quoter-v2:deployment-code-mismatch": 1 },
    });
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
    const measuredTarget = makeUniswapV3Target();
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
    const measuredTarget = makeUniswapV3Target();
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
    const measuredTarget = makeUniswapV3Target();
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
        nowSec: 11_861,
      }).size,
    ).toBe(0);
  });

  it("rejects a last-known-good profile once its original quote clock is stale", () => {
    const measuredTarget = makeUniswapV3Target();
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
      nowSec: 11_861,
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
