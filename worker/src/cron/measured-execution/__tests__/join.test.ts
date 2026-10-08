import { afterEach, describe, expect, it, vi } from "vitest";
import { CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS } from "@shared/lib/measured-execution-deployment-policies";
import { capabilityForPool, requiresP4DexScoreEligibleCapabilityCoverage } from "@shared/lib/p4-exit-route-capability-policy";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";

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
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { type SolanaDexNativeGeneration } from "@shared/types/solana-dex-bank";
import { buildNativeDexExecutionTarget } from "../inventory";
import { publishNativeDexGeneration } from "../native-generation-store";
import type { PoolEntry } from "../../dex-liquidity/types";
import {
  buildDexMeasuredExecutionRetainedRoutePools,
  joinDexMeasuredExecutionEvidence,
  loadNativeDexExecutionDiagnostic,
  releaseDexMeasuredExecutionProofFields,
  stripDexMeasuredExecutionInternalFields,
  type DexMeasuredExecutionJoinDiagnostics,
} from "../join";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import { getDexMeasuredExecutionDeployment } from "../registry";
import {
  CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  CURVE_CRYPTOSWAP_REVIEWED_COHORT,
  encodeCurveCryptoSwapGetDy,
} from "../curve-cryptoswap";
import * as curveCryptoSwap from "../curve-cryptoswap";
import {
  CURVE_3POOL_STABLESWAP_POLICY,
} from "../curve-stableswap";
import {
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  CURVE_USDG_USDC_STABLESWAP_NG_POLICY,
  getCurveStableSwapNgPolicy,
} from "../curve-stableswap-ng";
import {
  CURVE_NXUSD_METAPOOL_POLICY,
  CURVE_R3_METAPOOL_POLICIES,
  CURVE_USD1_METAPOOL_POLICY,
} from "@shared/lib/curve-composite-policies";
import { UNISWAP_V4_ADAPTER_PROFILE_ID } from "../uniswap-v4";
import {
  makeCurve3PoolPacket,
  makeCurveCompositeRoute,
  makeCurveStableSwapNgRoute,
  makeUniswapV4Route,
  makeV3Target,
} from "./measured-execution.test-support";
import {
  makeJoinPoints,
  makeJoinPool,
  makeJoinQuote,
  makeObservationHistory,
  makeV3LkgRoute,
} from "./join.test-support";



describe("measured execution join activation", () => {
  it("joins reviewed hook-free Ethereum V4 evidence without an activation gate", () => {
    const { measuredTarget, profile } = makeUniswapV4Route();
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

  it("keeps all ten reviewed metapool quotes display-only behind the activation gate", () => {
    for (const policy of CURVE_R3_METAPOOL_POLICIES) {
      const { measuredTarget, profile } = makeCurveCompositeRoute(policy);
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

  it("keeps the reviewed USD1 and NXUSD metapool adapters shadow-only", () => {
    for (const policy of [CURVE_USD1_METAPOOL_POLICY, CURVE_NXUSD_METAPOOL_POLICY]) {
      const { measuredTarget, profile } = makeCurveCompositeRoute(policy);
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
        observationHistory: makeObservationHistory(profiles[index]!),
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
        observationHistory: makeObservationHistory(profiles[index]!, {
          completeProducerCycleCount: 3,
          successfulObservationCount: 3,
          latestOperationalFailureAt: 1_060,
        }),
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
    const measuredTarget = makeV3Target({ chain: "optimism" });
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: 1_060,
      blockNumber: 25_536_894,
      endpointAddress: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
      endpointCodeHash: "0xd833dcf44a912014423afa2b637f23b5db5b7dc492494cbe3f46026a6d57b424",
      points: makeJoinPoints([[1_000, 999], [100_000, 99_900]]),
    });
    const pool = makeJoinPool(measuredTarget);

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([
          [
            measuredTarget.targetId,
            makeJoinQuote(measuredTarget, profile),
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
    const measuredTarget = makeV3Target({
      chain: "base", adapterProfileId: "aerodrome-slipstream-quoter-v2",
      protocol: "aerodrome-slipstream", feePips: undefined, tickSpacing: 1,
    });
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
      points: makeJoinPoints([[1_000, 999], [100_000, 99_900]]),
    });
    const pool = makeJoinPool(measuredTarget, { poolType: "aerodrome-slipstream-1bp", source: "direct_api" });

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([
          [
            measuredTarget.targetId,
            makeJoinQuote(measuredTarget, profile),
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
            makeJoinQuote(measuredTarget, profile, {
              resolution: "last-known-good",
              latestFailureReason: "quote-missing",
              observationHistory: makeObservationHistory(profile),
            }),
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
    const { measuredTarget, profile } = makeV3LkgRoute([[1_000, 970]]);
    const currentTarget = { ...measuredTarget, capturedAt: 2_000 };
    const pool = makeJoinPool(currentTarget);

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[currentTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation-latest",
        targetGenerationId: "target-generation-latest",
        publishedAt: 2_000,
        byTargetId: new Map([
          [
            currentTarget.targetId,
            makeJoinQuote(measuredTarget, profile, {
              resolution: "last-known-good",
              latestFailureReason: "request-budget-exhausted",
              observationHistory: makeObservationHistory(profile, {
                completeProducerCycleCount: 3,
                consecutiveSuccessCount: 0,
                observationWindowEndedAt: 2_000,
                latestOperationalFailureAt: 2_000,
              }),
            }),
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
    const { measuredTarget, profile } = makeV3LkgRoute([[1_000, 999], [100_000, 99_900]]);
    const evidence = {
      quoteGenerationId: "quote-generation-latest",
      targetGenerationId: "target-generation-latest",
      publishedAt: 2_000,
      byTargetId: new Map([
        [
          measuredTarget.targetId,
          makeJoinQuote(measuredTarget, profile, {
            resolution: "last-known-good",
            latestFailureReason: "quote-missing",
            observationHistory: makeObservationHistory(profile, {
              completeProducerCycleCount: 3,
              observationWindowEndedAt: 2_000,
            }),
          }),
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
    const { measuredTarget, profile } = makeV3LkgRoute([[1_000, 999]]);
    const quote = {
      quotedTarget: measuredTarget,
      status: "measured" as const,
      failureReason: null,
      profile,
      quoteGenerationId: "quote-generation-lkg",
      targetGenerationId: "target-generation-lkg",
      resolution: "last-known-good" as const,
      latestFailureReason: "quote-missing",
      observationHistory: makeObservationHistory(profile, {
        completeProducerCycleCount: 1,
        successfulObservationCount: 1,
        consecutiveSuccessCount: 1,
        observationWindowStartedAt: 1_060,
      }),
    };
    const evidence = {
      quoteGenerationId: "quote-generation-latest",
      targetGenerationId: "target-generation-latest",
      publishedAt: 2_000,
      byTargetId: new Map([[measuredTarget.targetId, quote]]),
    };
    const currentPool = makeJoinPool(measuredTarget);

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
    const { measuredTarget, profile } = makeV3LkgRoute([[1_000, 970]]);
    const pool = makeJoinPool(measuredTarget);

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation-latest",
        targetGenerationId: "target-generation-latest",
        publishedAt: 2_000,
        byTargetId: new Map([
          [
            measuredTarget.targetId,
            makeJoinQuote(measuredTarget, profile, {
              resolution: "last-known-good",
              latestFailureReason: "quoter-rpc-unavailable",
            }),
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

  it.each([
    { description: "a pinned pool", poolAddress: "0x6e5492f8ea2370844ee098a56dd88e1717e4a9c2", missingPin: false },
    { description: "a reviewed deployment family", poolAddress: "0x384ca8992f955009bdd94849488e580559590157", missingPin: false },
    { description: "a pinned policy missing its hash", poolAddress: "0x6e5492f8ea2370844ee098a56dd88e1717e4a9c2", missingPin: true },
  ])("preserves endpoint admission for $description", ({ poolAddress, missingPin }) => {
    const policy = CURVE_CRYPTOSWAP_REVIEWED_COHORT.find((entry) => entry.poolAddress === poolAddress);
    if (!policy) throw new Error("missing active Curve policy");
    const familyAnchored = policy.identityAnchor === "reviewed-deployment-family";
    const endpointCodeHash = familyAnchored
      ? "0x12aa5e0c6b126a29cf3f4ac61c317feddb54c59ead667daf444abce8679d0c54"
      : policy.expectedPoolCodeHash!;
    const amountInRaw = 1_000n * 10n ** 18n;
    const amountOutRaw = familyAnchored ? amountInRaw : 400_000_000_000_000_000n;
    const largeAmountOutRaw = familyAnchored ? 100_000n * 10n ** 18n : 40n * 10n ** 18n;
    const tokenAddresses = (familyAnchored
      ? ["0x16f93ebc5320c89efc8701577efe49d14a276a06", "0xcacd6fd266af91b8aed52accc382b4e165586e29"]
      : ["0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]
    ) as [`0x${string}`, `0x${string}`];
    const input = {
      schemaVersion: "dex-measured-target-v1" as const,
      stablecoinId: familyAnchored ? "cadd-cad-digital" : "crvusd-curve",
      adapterProfileId: CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
      protocol: "curve",
      chain: "ethereum",
      poolId: `ethereum:${policy.poolAddress}`,
      poolTokenAddresses: tokenAddresses,
      tokenIn: {
        address: tokenAddresses[0],
        symbol: familyAnchored ? "CADD" : "crvUSD",
        decimals: 18,
        referencePriceUsd: 1,
        trackedAssetId: familyAnchored ? "cadd-cad-digital" : "crvusd-curve",
      },
      tokenOut: {
        address: tokenAddresses[1],
        symbol: familyAnchored ? "frxUSD" : "WETH",
        decimals: 18,
        referencePriceUsd: familyAnchored ? 1 : 2_500,
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
      endpointCodeHash,
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
          amountOutRaw: largeAmountOutRaw.toString(),
          callData: encodeCurveCryptoSwapGetDy({
            inputIndex: 0,
            outputIndex: 1,
            amountInRaw: 100_000n * 10n ** 18n,
          }),
          returnData: `0x${largeAmountOutRaw.toString(16).padStart(64, "0")}`,
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

    const joinInput = {
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([[measuredTarget.targetId, {
          quotedTarget: measuredTarget,
          status: "measured" as const,
          failureReason: null,
          profile,
          quoteGenerationId: "quote-generation",
          targetGenerationId: "target-generation",
          resolution: "latest" as const,
          latestFailureReason: null,
        }]]),
      },
      nowSec: 1_060,
    };

    let diagnostics: DexMeasuredExecutionJoinDiagnostics;
    if (missingPin) {
      const originalResolver = curveCryptoSwap.getCurveCryptoSwapReviewedPolicy;
      const resolver = vi.spyOn(curveCryptoSwap, "getCurveCryptoSwapReviewedPolicy").mockImplementation(
        (chain, address) => {
          const resolved = originalResolver(chain, address);
          return resolved ? { ...resolved, expectedPoolCodeHash: undefined } : null;
        },
      );
      try {
        diagnostics = joinDexMeasuredExecutionEvidence(joinInput);
      } finally {
        resolver.mockRestore();
      }
      expect(diagnostics).toMatchObject({ measuredCount: 0, gatedCount: 1 });
      expect(pool.extra?.measuredExecution).toBeUndefined();
      expect(pool.extra?.executionCapabilityGate).toEqual({
        family: "measured-execution",
        reason: "deployment-code-mismatch",
      });
      expect(pool.extra?.measuredExecutionDiagnostic?.detail).toBe("endpoint-code-hash-mismatch");
    } else {
      diagnostics = joinDexMeasuredExecutionEvidence(joinInput);
      expect(diagnostics).toMatchObject({ measuredCount: 1, gatedCount: 0 });
      expect(pool.extra?.measuredExecution?.capacityCurve).toContainEqual({
        requestedNotionalUsd: 100_000,
        maxCostBps: 200,
        executableUsd: 100_000,
        completionRatio: 1,
        executionCostBps: 0,
      });
      expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    }
  });
});

describe("measured execution join AMM invariants", () => {
  it("keeps an independent exact AMM fallback available after a quote failure", () => {
    const measuredTarget = makeV3Target();
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

  it.each(CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS)("keeps $stablecoinId NG evidence activation-pending through coverage assembly", (deployment) => {
    const policy = getCurveStableSwapNgPolicy(deployment.chain, deployment.poolAddress)!;
    const { measuredTarget, profile } = makeCurveStableSwapNgRoute(policy);
    const pool = makeJoinPool(measuredTarget, { project: "curve", chain: deployment.chain });
    joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "curve-ng-quote-generation", targetGenerationId: "curve-ng-target-generation",
        publishedAt: 1_060, byTargetId: new Map([[measuredTarget.targetId, makeJoinQuote(measuredTarget, profile)]]),
      },
      nowSec: 1_060,
    });
    expect(pool.extra?.executionCapabilityGate?.reason).toBe("activation-pending");
    expect(capabilityForPool(pool).id).toBe("measured-adapter-shadow");
    expect(requiresP4DexScoreEligibleCapabilityCoverage(pool)).toBe(true);
    expect(buildP4DexExitRouteObservations({
      stablecoinId: measuredTarget.stablecoinId, retainedPools: [pool], observedAt: 1_060,
    }).observations).toHaveLength(0);
    delete pool.extra!.executionCapabilityGate;
    expect(capabilityForPool(pool).id).toBe("measured-adapter-shadow");
    expect(requiresP4DexScoreEligibleCapabilityCoverage(pool)).toBe(true);
    expect(buildP4DexExitRouteObservations({
      stablecoinId: measuredTarget.stablecoinId, retainedPools: [pool], observedAt: 1_060,
    }).observations).toHaveLength(0);
  });

  it("joins USDG NG evidence without displacing reserves before consumer-side 3/3 maturity", () => {
    const { measuredTarget, profile } = makeCurveStableSwapNgRoute();
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
    const pool = makeJoinPool(measuredTarget, {
      poolId: "defillama-usdg-ng-row",
      symbol: "USDG-USDC",
      volumeUsd1d: 10_000_000,
      poolType: "curve-stableswap-high-a",
      source: "dl",
      extra: {
        measuredExecutionTarget: measuredTarget,
        ammExecutionModel: reserveModel,
      },
    });
    const quote = (completeCycles: number, successfulCycles: number) => makeJoinQuote(measuredTarget, profile, {
      observationHistory: makeObservationHistory(profile, {
        completeProducerCycleCount: completeCycles,
        successfulObservationCount: successfulCycles,
        consecutiveSuccessCount: successfulCycles,
      }),
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
    expect(pool.extra?.measuredExecutionDiagnostics).toEqual(targets.map((target) =>
      expect.objectContaining({ targetId: target.targetId, detail: "atomic-direction-missing" }),
    ));
    expect(diagnostics).toMatchObject({ targetCount: 2, measuredCount: 0, gatedCount: 2 });
  });
});

const nativeFixtures = createLatestSchemaFixtureTracker();
afterEach(() => nativeFixtures.closeAll());

function failedNativeGeneration(status: "failed" | "unavailable", clock = 1_000): SolanaDexNativeGeneration {
  return {
    schemaVersion: "solana-dex-generation-v1", generationId: `native-${clock}`, profileId: "orca-whirlpool-exact-v1",
    sourceGenerationId: "native-retained-source", startedAt: clock, publishedAt: clock + 60, scoreEligible: false,
    quotes: [{ target: buildNativeDexExecutionTarget({ chain: "solana", profileId: "orca-whirlpool-exact-v1",
      stablecoinId: "usdc-circle", poolAddress: "A".repeat(32), tokenMintIn: "B".repeat(32), tokenMintOut: "C".repeat(32) }),
      scoreEligible: false, bank: null, bankRef: null, proofRef: null,
      programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", arrayAddresses: [], dependencyAddresses: [],
      inputPriceUsd: 1, inputDecimals: 6, points: [{ status, notionalUsd: 1_000, quotedAt: clock + 30,
        reason: status === "failed" ? "native-array-exhausted" : "native-bank-unavailable" }] }],
  };
}

describe("native diagnostic reader isolation", () => {
  it("does not read an EVM publication as a missing native pointer", async () => {
    const { db, sqlite } = nativeFixtures.open();
    sqlite.prepare(`INSERT INTO surface_publication_generations
      (surface, generation_id, started_at, published_at, state, expected_rows, published_rows)
      VALUES ('dex-measured-execution-quotes', 'evm-current', 1000, 1060, 'published', 0, 0)`).run();
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: "orca-whirlpool-exact-v1", nowSec: 1_060 }))
      .toMatchObject({ status: "missing", reason: "native-pointer-missing", generationId: null, scoreEligible: false, quotes: [] });
  });

  it.each(["failed", "unavailable"] as const)("preserves current %s point outcomes without native or EVM fallback", async (status) => {
    const { db } = nativeFixtures.open();
    await publishNativeDexGeneration(db, failedNativeGeneration("failed"));
    const value = failedNativeGeneration(status, 2_000);
    await publishNativeDexGeneration(db, value);
    const diagnostic = await loadNativeDexExecutionDiagnostic({ db, profileId: value.profileId, nowSec: 2_060 });
    expect(diagnostic).toMatchObject({ status, generationId: value.generationId, scoreEligible: false,
      freshnessMaxSec: 10_800, quotes: [{ status, slot: null, points: [{ status }] }] });
    expect(diagnostic.quotes[0]!.points[0]).not.toHaveProperty("amountOutRaw");
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: "raydium-clmm-exact-v1", nowSec: 2_060 }))
      .toMatchObject({ status: "missing", generationId: null });
  });

  it("uses original observation clocks and the inclusive three-hour bound", async () => {
    const { db } = nativeFixtures.open();
    await publishNativeDexGeneration(db, failedNativeGeneration("failed"));
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: "orca-whirlpool-exact-v1", nowSec: 1_030 + 10_800 }))
      .toMatchObject({ status: "failed", publishedAt: 1_060, generationId: "native-1000" });
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: "orca-whirlpool-exact-v1", nowSec: 1_031 + 10_800 }))
      .toMatchObject({ status: "stale", reason: "native-observation-stale", quotes: [{ status: "stale" }] });
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: "orca-whirlpool-exact-v1", nowSec: 1_061 + 10_800 }))
      .toMatchObject({ status: "stale", reason: "native-generation-stale" });
  });

  it("does not fall back when current evidence is torn, unreadable or future-clocked", async () => {
    const { db, sqlite } = nativeFixtures.open();
    await publishNativeDexGeneration(db, failedNativeGeneration("failed"));
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: "orca-whirlpool-exact-v1", nowSec: 1_000 }))
      .toMatchObject({ status: "unavailable", reason: "native-generation-future" });
    sqlite.prepare("DELETE FROM dex_native_generation_quotes").run();
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: "orca-whirlpool-exact-v1", nowSec: 1_060 }))
      .toMatchObject({ status: "unavailable", reason: "native-generation-unavailable", quotes: [] });
    sqlite.exec("DROP TABLE dex_native_publication_pointers");
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: "orca-whirlpool-exact-v1", nowSec: 1_060 }))
      .toMatchObject({ status: "unavailable", reason: "native-generation-unavailable", generationId: null });
  });

  it("reports a current empty diagnostic generation as missing targets, not measured zero", async () => {
    const { db } = nativeFixtures.open();
    const value = failedNativeGeneration("failed");
    value.quotes = [];
    await publishNativeDexGeneration(db, value);
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: value.profileId, nowSec: 1_060 }))
      .toMatchObject({ status: "missing", reason: "native-target-missing", generationId: value.generationId, quotes: [] });
  });
});
