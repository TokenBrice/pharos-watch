import { describe, expect, it } from "vitest";

import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import {
  admitTargetsWithinBudget,
  estimateAdmissionCohortRpcRequests,
  estimateAdmissionRotationCycles,
  hasCompleteDexMeasuredQuoteProgress,
  resolveMeasuredExecutionCronStatus,
} from "../sync";

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
    adapterProfileId: "curve-stableswap-main-registry-get-dy-v1",
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

describe("measured execution overflow admission", () => {
  it("estimates each execution phase plus singleton-retry headroom", () => {
    expect(estimateAdmissionCohortRpcRequests([target("coin-low", 100_000)])).toBe(7);
    expect(estimateAdmissionCohortRpcRequests([target("coin-high", 10_000_000)])).toBe(10);
  });

  it("counts phase-separated batches at adapter and batch boundaries", () => {
    const lowTargets = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        target("coin-a", 100_000, `coin-a-${index}`),
      );
    expect(estimateAdmissionCohortRpcRequests(lowTargets(8))).toBe(14);
    expect(estimateAdmissionCohortRpcRequests(lowTargets(9))).toBe(21);
    expect(
      estimateAdmissionCohortRpcRequests([
        target("coin-a", 100_000),
        target("coin-b", 100_000, "coin-b", {
          chain: "base",
          adapterProfileId: "pancakeswap-v3-quoter-v2",
          protocol: "pancakeswap",
        }),
      ]),
    ).toBe(14);
    expect(
      estimateAdmissionCohortRpcRequests([
        target("coin-a", 100_000),
        target("coin-b", 100_000, "coin-b", {
          adapterProfileId: "fluid-resolver-measured",
          protocol: "fluid",
        }),
      ]),
    ).toBe(12);
  });

  it("recognizes both reviewed StableSwap directions as one quote-batch cohort", () => {
    const packet = [curveStableSwapTarget(0), curveStableSwapTarget(1)];

    expect(estimateAdmissionCohortRpcRequests(packet)).toBe(8);
    const admission = admitTargetsWithinBudget(packet, { maxEstimatedRpcRequests: 8 });
    expect([...admission.admitted]).toEqual([
      "target-curve-3pool-0",
      "target-curve-3pool-1",
    ]);
    expect(admission.deferred.size).toBe(0);
  });

  it("rotates the deterministic coin-level tail instead of starving it", () => {
    const targets = [target("coin-a", 100_000), target("coin-b", 100_000), target("coin-c", 100_000)];
    const first = admitTargetsWithinBudget(targets, {
      maxEstimatedRpcRequests: 7,
    });
    const second = admitTargetsWithinBudget(targets, {
      cursor: first.nextCursor,
      maxEstimatedRpcRequests: 7,
    });
    const third = admitTargetsWithinBudget(targets, {
      cursor: second.nextCursor,
      maxEstimatedRpcRequests: 7,
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
    const first = admitTargetsWithinBudget(targets, { maxEstimatedRpcRequests: 10 });
    const second = admitTargetsWithinBudget(targets, {
      cursor: first.nextCursor,
      maxEstimatedRpcRequests: 10,
    });
    const third = admitTargetsWithinBudget(targets, {
      cursor: second.nextCursor,
      maxEstimatedRpcRequests: 10,
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
      estimateAdmissionRotationCycles(targets, { maxEstimatedRpcRequests: 10 }),
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
    const first = admitTargetsWithinBudget(targets, { maxEstimatedRpcRequests: 11 });
    const second = admitTargetsWithinBudget(targets, {
      cursor: first.nextCursor,
      maxEstimatedRpcRequests: 11,
    });

    expect([...first.admitted]).toEqual(["target-coin-a", "target-coin-c"]);
    expect([...first.deferred]).toEqual([
      "target-coin-b-1",
      "target-coin-b-2",
      "target-coin-b-3",
      "target-coin-b-4",
    ]);
    expect(first.estimatedRpcRequests).toBe(11);
    expect(first.nextCursor).toBe("coin-a");
    expect([...second.admitted]).toContain("target-coin-b-1");
    expect(
      estimateAdmissionRotationCycles(targets, { maxEstimatedRpcRequests: 11 }),
    ).toBe(2);
  });

  it("surfaces an oversized coin group and continues admitting later groups", () => {
    const admission = admitTargetsWithinBudget(
      [
        target("coin-a", 100_000, "coin-a-1"),
        target("coin-a", 100_000, "coin-a-2"),
        target("coin-b", 100_000),
      ],
      { maxEstimatedRpcRequests: 7 },
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
        deferredCount: 0,
        admissionRotationCycles: 1,
        cursorWriteStatus: "missing-table",
      }),
    ).toBe("ok");
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 0,
        deferredCount: 2,
        admissionRotationCycles: 2,
        cursorWriteStatus: "missing-table",
      }),
    ).toBe("degraded");
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
