import { describe, expect, it } from "vitest";

import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { DexExitRouteObservation } from "@shared/types/market";
import {
  MEASURED_EXECUTION_ADMISSION_RUN_METADATA,
  admitTargetsWithinBudget,
  collectScoreBearingTargetIds,
  estimateAdmissionCohortRpcRequestBreakdown,
  estimateAdmissionCohortRpcRequests,
  estimateAdmissionRotationCycles,
  hasCompleteDexMeasuredQuoteProgress,
  isDexMeasuredExecutionTargetScoreEligible,
  isDiagnosticDexMeasuredQuoteFailure,
  resolveMeasuredExecutionCronStatus,
  selectExpiringScoreBearingPriorityPacket,
  summarizeMeasuredExecutionQuoteFailures,
  type PublishedScoreBearingDexRoute,
} from "../admission";
import {
  UNISWAP_V4_ADAPTER_PROFILE_ID,
  UNISWAP_V4_HOOK_FREE_ADDRESS,
  computeUniswapV4PoolId,
} from "../uniswap-v4";
import {
  CURVE_DOLA_SUSDE_RATE_BEARING_POLICY,
  CURVE_NXUSD_METAPOOL_POLICY,
} from "../curve-composite";

function target(
  stablecoinId: string,
  retainedTvlUsd: number,
  suffix = stablecoinId,
  overrides: Partial<DexMeasuredExecutionTarget> = {},
): DexMeasuredExecutionTarget {
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId: `target-${suffix}`,
    stablecoinId,
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "ethereum",
    poolId: "0x1111111111111111111111111111111111111111",
    tokenIn: {
      address: "0x2222222222222222222222222222222222222222",
      symbol: stablecoinId,
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: stablecoinId,
    },
    tokenOut: {
      address: "0x3333333333333333333333333333333333333333",
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    feePips: 100,
    retainedTvlUsd,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
    ...overrides,
  };
}

function curveStableSwapTarget(outputIndex: 0 | 1): DexMeasuredExecutionTarget {
  const poolTokens = [
    "0x6b175474e89094c44da98b954eedeac495271d0f",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
  ];
  return target("usdt-tether", 160_000_000, `curve-3pool-${outputIndex}`, {
    adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap,
    protocol: "curve",
    chain: "ethereum",
    poolId: "ethereum:0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
    poolTokenAddresses: poolTokens,
    tokenIn: {
      address: poolTokens[2]!,
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 0.99925,
      trackedAssetId: "usdt-tether",
    },
    tokenOut: {
      address: poolTokens[outputIndex]!,
      symbol: outputIndex === 0 ? "DAI" : "USDC",
      decimals: outputIndex === 0 ? 18 : 6,
      referencePriceUsd: 1,
      trackedAssetId: outputIndex === 0 ? "dai-makerdao" : "usdc-circle",
    },
  });
}

function curveStableSwapNgTarget(): DexMeasuredExecutionTarget {
  const poolTokens = [
    "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  ];
  return target("usdg-paxos", 20_501_133, "curve-usdg-ng", {
    adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
    protocol: "curve",
    chain: "ethereum",
    poolId: "ethereum:0xc061caa073f3d95f80f8e5428d32d2d76f5e1622",
    poolTokenAddresses: poolTokens,
    tokenIn: {
      address: poolTokens[0]!,
      symbol: "USDG",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdg-paxos",
    },
    tokenOut: {
      address: poolTokens[1]!,
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
  });
}

function curveNxusdTarget(): DexMeasuredExecutionTarget {
  const policy = CURVE_NXUSD_METAPOOL_POLICY;
  const tokenIn = policy.executionTokens[policy.inputIndex]!;
  const tokenOut = policy.executionTokens[policy.outputIndex]!;
  return target(policy.stablecoinId, 328_267, "curve-nxusd", {
    adapterProfileId: policy.adapterProfileId,
    protocol: "curve",
    chain: policy.chain,
    poolId: `${policy.chain}:${policy.poolAddress}`,
    poolTokenAddresses: policy.executionTokens.map((token) => token.address),
    tokenIn: {
      ...tokenIn,
      referencePriceUsd: 0.8094,
    },
    tokenOut: {
      ...tokenOut,
      referencePriceUsd: 0.99986,
    },
  });
}

function publishedRoute(
  measuredTarget: DexMeasuredExecutionTarget,
  observedAt: number,
): PublishedScoreBearingDexRoute {
  const observation: DexExitRouteObservation = {
    routeId: `dex:test:${measuredTarget.targetId}`,
    routeFamily: "dex-amm",
    scope: {
      kind: "chain-contract",
      chain: measuredTarget.chain,
      contractOrPoolId: measuredTarget.poolId,
      protocol: measuredTarget.protocol,
    },
    requestedNotionalUsd: 25_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 10_000_000,
    completionRatio: 0.4,
    output: {
      kind: "tracked-stablecoin",
      trackedAssetIds: measuredTarget.tokenOut.trackedAssetId
        ? [measuredTarget.tokenOut.trackedAssetId]
        : undefined,
      assetKeys: [`${measuredTarget.chain.toLowerCase()}:${measuredTarget.tokenOut.address}`],
    },
    evidenceKind: "measured-executable-depth",
    adapterProfileId: measuredTarget.adapterProfileId,
    confidence: "high",
    scoreEligible: true,
    observedAt,
    freshnessSeconds: 0,
    commonModeKeys: [
      `chain:${measuredTarget.chain.toLowerCase()}`,
      `pool:${measuredTarget.poolId}`,
    ],
  };
  return { stablecoinId: measuredTarget.stablecoinId, observation };
}

describe("measured execution overflow admission", () => {
  it("reports the default hard, admission, and reserve limits", () => {
    expect(MEASURED_EXECUTION_ADMISSION_RUN_METADATA).toEqual({
      admissionRpcRequestLimit: 1_220,
      admissionFragmentationReserveRpcRequests: 80,
      admissionRpcHardLimit: 1_300,
    });
    expect(
      MEASURED_EXECUTION_ADMISSION_RUN_METADATA.admissionRpcRequestLimit +
        MEASURED_EXECUTION_ADMISSION_RUN_METADATA
          .admissionFragmentationReserveRpcRequests,
    ).toBe(
      MEASURED_EXECUTION_ADMISSION_RUN_METADATA.admissionRpcHardLimit,
    );
  });

  it("estimates setup, execution phases, and singleton-retry headroom", () => {
    expect(estimateAdmissionCohortRpcRequestBreakdown([target("coin-low", 100_000)]))
      .toEqual({ setupRpcRequests: 3, quoteRpcRequests: 7, totalRpcRequests: 10 });
    expect(estimateAdmissionCohortRpcRequests([target("coin-high", 10_000_000)])).toBe(13);
  });

  it("counts phase-separated batches at adapter and batch boundaries", () => {
    const lowTargets = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        target("coin-a", 100_000, `coin-a-${index}`),
      );
    expect(estimateAdmissionCohortRpcRequests(lowTargets(8))).toBe(17);
    expect(estimateAdmissionCohortRpcRequests(lowTargets(9))).toBe(24);
    expect(
      estimateAdmissionCohortRpcRequests([
        target("coin-a", 100_000),
        target("coin-b", 100_000, "coin-b", {
          chain: "base",
          adapterProfileId: "pancakeswap-v3-quoter-v2",
          protocol: "pancakeswap",
        }),
      ]),
    ).toBe(20);
  });

  it("budgets V4 runtime bindings and pinned pool-state proof", () => {
    const poolTokenAddresses = [
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
    ] as const;
    const poolId = computeUniswapV4PoolId({
      currency0: poolTokenAddresses[0],
      currency1: poolTokenAddresses[1],
      feePips: 100,
      tickSpacing: 1,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    });
    const measuredTarget = target("usdc-circle", 20_000_000, "uniswap-v4", {
      adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID,
      protocol: "uniswap-v4",
      poolId: `ethereum:${poolId}`,
      poolTokenAddresses: [...poolTokenAddresses],
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
    });

    expect(estimateAdmissionCohortRpcRequestBreakdown([measuredTarget])).toEqual({
      setupRpcRequests: 5,
      quoteRpcRequests: 9,
      totalRpcRequests: 14,
    });
  });

  it("recognizes both reviewed StableSwap directions as one quote-batch cohort", () => {
    const packet = [curveStableSwapTarget(0), curveStableSwapTarget(1)];

    expect(estimateAdmissionCohortRpcRequestBreakdown(packet)).toEqual({
      setupRpcRequests: 12,
      quoteRpcRequests: 8,
      totalRpcRequests: 20,
    });
    const admission = admitTargetsWithinBudget(packet, { maxEstimatedRpcRequests: 20 });
    expect([...admission.admitted]).toEqual([
      "target-curve-3pool-0",
      "target-curve-3pool-1",
    ]);
    expect(admission.deferred.size).toBe(0);
  });

  it("admits the reviewed USDG StableSwap-NG route as one exact quote cohort", () => {
    const measuredTarget = curveStableSwapNgTarget();

    expect(estimateAdmissionCohortRpcRequestBreakdown([measuredTarget])).toEqual({
      setupRpcRequests: 11,
      quoteRpcRequests: 8,
      totalRpcRequests: 19,
    });
    const admission = admitTargetsWithinBudget([measuredTarget], {
      maxEstimatedRpcRequests: 19,
    });
    expect([...admission.admitted]).toEqual(["target-curve-usdg-ng"]);
    expect(admission.deferred.size).toBe(0);
  });

  it("counts every NXUSD composite identity proof before ordinary cursor admission", () => {
    const measuredTarget = curveNxusdTarget();

    expect(estimateAdmissionCohortRpcRequestBreakdown([measuredTarget])).toEqual({
      setupRpcRequests: 20,
      quoteRpcRequests: 6,
      totalRpcRequests: 26,
    });
    expect(
      admitTargetsWithinBudget([measuredTarget], {
        maxEstimatedRpcRequests: 25,
      }).admitted.size,
    ).toBe(0);
    expect(
      [...admitTargetsWithinBudget([measuredTarget], {
        maxEstimatedRpcRequests: 26,
      }).admitted],
    ).toEqual(["target-curve-nxusd"]);
  });

  it("reserves the published score-bearing packet with the earliest expiry", () => {
    const normal = target("coin-normal", 100_000);
    const stable = curveStableSwapNgTarget();
    const selected = selectExpiringScoreBearingPriorityPacket(
      [normal, stable],
      [
        publishedRoute(normal, 2_000),
        publishedRoute(stable, 0),
      ],
    );

    // Every measured route expires at +10800, so the older NG quote (observed
    // at 0) expires before the normal route observed at 2000.
    expect(selected).toEqual({
      targetIds: [stable.targetId],
      observedAtSec: 0,
      expiresAtSec: 10_800,
      estimatedRpcRequests: 19,
    });
  });

  it("keeps the two reviewed StableSwap directions atomic in priority admission", () => {
    const packet = [curveStableSwapTarget(0), curveStableSwapTarget(1)];
    const selected = selectExpiringScoreBearingPriorityPacket(
      packet,
      packet.map((row) => publishedRoute(row, 1_000)),
    );

    expect(selected).toEqual({
      targetIds: [
        "target-curve-3pool-0",
        "target-curve-3pool-1",
      ],
      observedAtSec: 1_000,
      expiresAtSec: 11_800,
      estimatedRpcRequests: 20,
    });
  });

  it("does not reserve a partial StableSwap priority packet", () => {
    const packet = [curveStableSwapTarget(0), curveStableSwapTarget(1)];

    expect(
      selectExpiringScoreBearingPriorityPacket(
        packet,
        [publishedRoute(packet[0]!, 1_000)],
      ),
    ).toBeNull();
  });
  it("rejects targets outside the current score-bearing route set", () => {
    const scored = target("coin-scored", 100_000, "scored");
    const outside = target("coin-outside", 100_000, "outside");
    const scoreBearingTargetIds = collectScoreBearingTargetIds(
      [scored, outside],
      [publishedRoute(scored, 1_000)],
    );
    const admission = admitTargetsWithinBudget([scored, outside], {
      maxEstimatedRpcRequests: 20,
      scoreBearingTargetIds,
    });

    expect(admission.admitted).toEqual(new Set([scored.targetId]));
    expect(admission.excluded).toEqual(new Set([outside.targetId]));
  });


  it("admits one bounded priority without letting it advance the tail cursor", () => {
    const priority = target("coin-priority", 100_000);
    const tail = target("coin-tail", 100_000, "coin-tail", {
      chain: "base",
      adapterProfileId: "pancakeswap-v3-quoter-v2",
      protocol: "pancakeswap",
    });
    const admission = admitTargetsWithinBudget([priority, tail], {
      cursor: "coin-priority",
      maxEstimatedRpcRequests: 10,
      priorityTargetIds: new Set([priority.targetId]),
      priorityMaxEstimatedRpcRequests: 20,
    });

    expect([...admission.priorityAdmitted]).toEqual([priority.targetId]);
    expect([...admission.admitted]).toEqual([priority.targetId]);
    expect([...admission.deferred]).toEqual([tail.targetId]);
    expect(admission.estimatedRpcRequests).toBe(10);
    expect(admission.nextCursor).toBe("coin-priority");
  });

  it("rejects a priority packet above its separate reservation cap", () => {
    const packet = [curveStableSwapTarget(0), curveStableSwapTarget(1)];
    const admission = admitTargetsWithinBudget(packet, {
      maxEstimatedRpcRequests: 20,
      priorityTargetIds: new Set(packet.map((row) => row.targetId)),
      priorityMaxEstimatedRpcRequests: 19,
    });

    expect(admission.priorityAdmitted.size).toBe(0);
    expect(admission.estimatedRpcRequests).toBeLessThanOrEqual(20);
  });

  it("keeps the priority reservation at 20 when a caller requests a higher cap", () => {
    const packet = [
      curveStableSwapTarget(0),
      curveStableSwapTarget(1),
      target("coin-extra", 100_000, "coin-extra", {
        chain: "base",
        adapterProfileId: "pancakeswap-v3-quoter-v2",
        protocol: "pancakeswap",
      }),
    ];
    const admission = admitTargetsWithinBudget(packet, {
      maxEstimatedRpcRequests: 100,
      priorityTargetIds: new Set(packet.map((row) => row.targetId)),
      priorityMaxEstimatedRpcRequests: 100,
    });

    expect(estimateAdmissionCohortRpcRequests(packet)).toBeGreaterThan(20);
    expect(admission.priorityAdmitted.size).toBe(0);
  });

  it("keeps selector overrides from admitting a packet estimated above 20", () => {
    const policy = CURVE_DOLA_SUSDE_RATE_BEARING_POLICY;
    const tokenIn = policy.poolTokens[policy.inputIndex]!;
    const tokenOut = policy.poolTokens[policy.outputIndex]!;
    const composite = target(
      policy.stablecoinId,
      39_000_000,
      "curve-composite",
      {
        adapterProfileId: policy.adapterProfileId,
        protocol: "curve",
        chain: policy.chain,
        poolId: `${policy.chain}:${policy.poolAddress}`,
        poolTokenAddresses: policy.poolTokens.map((token) => token.address),
        tokenIn: {
          ...tokenIn,
          referencePriceUsd: 1.24,
        },
        tokenOut: {
          ...tokenOut,
          referencePriceUsd: 0.996,
        },
      },
    );

    expect(estimateAdmissionCohortRpcRequests([composite])).toBeGreaterThan(20);
    expect(
      selectExpiringScoreBearingPriorityPacket(
        [composite],
        [publishedRoute(composite, 1_000)],
        100,
      ),
    ).toBeNull();
  });

  it("rotates the deterministic coin-level tail instead of starving it", () => {
    const targets = [target("coin-a", 100_000), target("coin-b", 100_000), target("coin-c", 100_000)];
    const first = admitTargetsWithinBudget(targets, {
      maxEstimatedRpcRequests: 10,
    });
    const second = admitTargetsWithinBudget(targets, {
      cursor: first.nextCursor,
      maxEstimatedRpcRequests: 10,
    });
    const third = admitTargetsWithinBudget(targets, {
      cursor: second.nextCursor,
      maxEstimatedRpcRequests: 10,
    });

    expect([...first.admitted]).toEqual(["target-coin-a"]);
    expect([...second.admitted]).toEqual(["target-coin-b"]);
    expect([...third.admitted]).toEqual(["target-coin-c"]);
    expect(first.deferred.size).toBe(2);
    expect(second.deferred.size).toBe(2);
    expect(third.deferred.size).toBe(2);
  });

  it("rotates heterogeneous coin groups without starving the tail", () => {
    const targets = [
      target("coin-a", 100_000, "coin-a-1"),
      target("coin-a", 100_000, "coin-a-2"),
      target("coin-a", 100_000, "coin-a-3"),
      target("coin-a", 100_000, "coin-a-4"),
      target("coin-b", 10_000_000),
      target("coin-c", 100_000),
    ];
    const first = admitTargetsWithinBudget(targets, { maxEstimatedRpcRequests: 13 });
    const second = admitTargetsWithinBudget(targets, {
      cursor: first.nextCursor,
      maxEstimatedRpcRequests: 13,
    });
    const third = admitTargetsWithinBudget(targets, {
      cursor: second.nextCursor,
      maxEstimatedRpcRequests: 13,
    });

    expect([...first.admitted]).toEqual(["target-coin-b"]);
    expect([...second.admitted]).toEqual([
      "target-coin-a-1",
      "target-coin-a-2",
      "target-coin-a-3",
      "target-coin-a-4",
    ]);
    expect([...third.admitted]).toEqual(["target-coin-c"]);
    expect(new Set([...first.admitted, ...second.admitted, ...third.admitted]).size).toBe(6);
    expect(
      estimateAdmissionRotationCycles(targets, { maxEstimatedRpcRequests: 13 }),
    ).toBe(3);
  });

  it("packs later cohorts while resuming at the first deferred cohort", () => {
    const targets = [
      target("coin-a", 10_000_000),
      target("coin-b", 100_000, "coin-b-1"),
      target("coin-b", 100_000, "coin-b-2"),
      target("coin-b", 100_000, "coin-b-3"),
      target("coin-b", 100_000, "coin-b-4"),
      target("coin-c", 100_000),
    ];
    const first = admitTargetsWithinBudget(targets, { maxEstimatedRpcRequests: 14 });
    const second = admitTargetsWithinBudget(targets, {
      cursor: first.nextCursor,
      maxEstimatedRpcRequests: 14,
    });

    expect([...first.admitted]).toEqual(["target-coin-a", "target-coin-c"]);
    expect([...first.deferred]).toEqual([
      "target-coin-b-1",
      "target-coin-b-2",
      "target-coin-b-3",
      "target-coin-b-4",
    ]);
    expect(first.estimatedRpcRequests).toBe(14);
    expect(first.nextCursor).toBe("coin-a");
    expect([...second.admitted]).toContain("target-coin-b-1");
    expect(
      estimateAdmissionRotationCycles(targets, { maxEstimatedRpcRequests: 14 }),
    ).toBe(2);
  });

  it("surfaces an oversized coin group and continues admitting later groups", () => {
    const admission = admitTargetsWithinBudget(
      [
        target("coin-a", 100_000, "coin-a-1"),
        target("coin-a", 100_000, "coin-a-2"),
        target("coin-b", 100_000),
      ],
      { maxEstimatedRpcRequests: 10 },
    );

    expect(admission.oversizedCoinIds).toEqual(["coin-a"]);
    expect([...admission.oversized]).toEqual(["target-coin-a-1", "target-coin-a-2"]);
    expect([...admission.admitted]).toEqual(["target-coin-b"]);
  });

  it("keeps durable budget deferral healthy while degrading actionable or non-durable gaps", () => {
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 0,
        deferredCount: 2,
        admissionRotationCycles: 2,
        cursorWriteStatus: "written",
      }),
    ).toBe("ok");
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 0,
        deferredCount: 2,
        admissionRotationCycles: 2,
        cursorWriteStatus: "write-failed",
      }),
    ).toBe("degraded");
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 1,
        deferredCount: 0,
        admissionRotationCycles: 1,
        cursorWriteStatus: "not-needed",
      }),
    ).toBe("degraded");
  });

  it("classifies score-eligible EVM targets separately from shadow diagnostics", () => {
    expect(isDexMeasuredExecutionTargetScoreEligible(target("coin-a", 100_000))).toBe(true);
    expect(
      isDexMeasuredExecutionTargetScoreEligible(
        target("coin-b", 100_000, "base-univ3", {
          chain: "base",
          adapterProfileId: "uniswap-v3-quoter-v2",
          protocol: "uniswap-v3",
        }),
      ),
    ).toBe(false);
    expect(
      isDexMeasuredExecutionTargetScoreEligible(
        target("coin-d", 100_000, "aero", {
          chain: "base",
          adapterProfileId: "aerodrome-slipstream-quoter-v2",
          protocol: "aerodrome-slipstream",
        }),
      ),
    ).toBe(true);
    expect(
      isDexMeasuredExecutionTargetScoreEligible(
        target("coin-e", 100_000, "uniswap-v4", {
          chain: "ethereum",
          adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID,
          protocol: "uniswap-v4",
        }),
      ),
    ).toBe(true);
  });

  it("keeps untracked pool-implied price mismatches diagnostic for cron status", () => {
    const poolImpliedDrift = target("coin-a", 100_000, "untracked-output", {
      tokenOut: {
        address: "0x3333333333333333333333333333333333333333",
        symbol: "PRD",
        decimals: 10,
        referencePriceUsd: 0.00052,
      },
    });
    const trackedMismatch = target("coin-b", 100_000, "tracked-output");
    const summary = summarizeMeasuredExecutionQuoteFailures([
      {
        target: poolImpliedDrift,
        status: "failed",
        failureReason: "profile-validation:quote-price-mismatch",
      },
      {
        target: trackedMismatch,
        status: "failed",
        failureReason: "profile-validation:quote-price-mismatch",
      },
      {
        target: target("coin-c", 100_000, "transport-failure"),
        status: "failed",
        failureReason: "transport-error",
      },
    ]);

    expect(isDiagnosticDexMeasuredQuoteFailure({
      target: poolImpliedDrift,
      status: "failed",
      failureReason: "profile-validation:quote-price-mismatch",
    })).toBe(true);
    expect(isDiagnosticDexMeasuredQuoteFailure({
      target: trackedMismatch,
      status: "failed",
      failureReason: "profile-validation:quote-price-mismatch",
    })).toBe(false);
    expect(summary).toMatchObject({
      attemptedFailureCount: 3,
      scoreEligibleAttemptedFailureCount: 3,
      scoreEligibleDiagnosticFailureCount: 1,
      scoreEligibleBlockingFailureCount: 2,
      diagnosticAttemptedFailureCount: 1,
    });
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: summary.scoreEligibleBlockingFailureCount,
        deferredCount: 0,
        admissionRotationCycles: 1,
        cursorWriteStatus: "not-needed",
      }),
    ).toBe("degraded");
  });

  it("does not degrade when only pool-implied price drift fails score-eligible quotes", () => {
    const poolImpliedDrift = target("coin-a", 100_000, "untracked-output", {
      tokenOut: {
        address: "0x3333333333333333333333333333333333333333",
        symbol: "PRD",
        decimals: 10,
        referencePriceUsd: 0.00052,
      },
    });
    const summary = summarizeMeasuredExecutionQuoteFailures([
      {
        target: poolImpliedDrift,
        status: "failed",
        failureReason: "profile-validation:quote-price-mismatch",
      },
    ]);

    expect(summary.scoreEligibleAttemptedFailureCount).toBe(1);
    expect(summary.scoreEligibleBlockingFailureCount).toBe(0);
    expect(summary.diagnosticAttemptedFailureCount).toBe(1);
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: summary.scoreEligibleBlockingFailureCount,
        deferredCount: 0,
        admissionRotationCycles: 1,
        cursorWriteStatus: "not-needed",
      }),
    ).toBe("ok");
  });

  it("keeps targets outside the published score-bearing set diagnostic", () => {
    const summary = summarizeMeasuredExecutionQuoteFailures([
      {
        target: target("coin-outside", 100_000),
        status: "failed",
        failureReason: "score-bearing-route-unavailable",
      },
    ]);

    expect(summary).toMatchObject({
      attemptedFailureCount: 0,
      scoreEligibleAttemptedFailureCount: 0,
      scoreEligibleBlockingFailureCount: 0,
    });
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: summary.scoreEligibleBlockingFailureCount,
        deferredCount: 0,
        admissionRotationCycles: 1,
        cursorWriteStatus: "not-needed",
      }),
    ).toBe("ok");
  });

  it("degrades rotation that cannot refresh every admitted target within one hour", () => {
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 0,
        deferredCount: 2,
        admissionRotationCycles: 3,
        cursorWriteStatus: "written",
      }),
    ).toBe("degraded");
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 0,
        deferredCount: 2,
        admissionRotationCycles: null,
        cursorWriteStatus: "written",
      }),
    ).toBe("degraded");
  });
});

describe("measured execution runtime budget completion", () => {
  it("preserves targets that completed their required probe set before the global budget stop", () => {
    const measuredTarget = target("coin-a", 100_000);

    expect(
      hasCompleteDexMeasuredQuoteProgress({
        target: measuredTarget,
        points: [{ inputUsd: 1_000 }, { inputUsd: 100_000 }],
        stopped: false,
      }),
    ).toBe(true);
    expect(
      hasCompleteDexMeasuredQuoteProgress({
        target: measuredTarget,
        points: [{ inputUsd: 1_000 }],
        stopped: false,
      }),
    ).toBe(false);
  });

  it("treats a deterministic cost-bound stop as complete, including measured zero", () => {
    expect(
      hasCompleteDexMeasuredQuoteProgress({
        target: target("coin-a", 10_000_000),
        points: [{ inputUsd: 1_000 }],
        stopped: true,
      }),
    ).toBe(true);
  });
});
