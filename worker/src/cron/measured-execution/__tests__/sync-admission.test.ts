import { describe, expect, it } from "vitest";

import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import {
  admitTargetsWithinBudget,
  estimateTargetAdmissionRpcRequests,
  hasCompleteDexMeasuredQuoteProgress,
  resolveMeasuredExecutionCronStatus,
  resolveMeasuredExecutionQuoteFailureReason,
} from "../sync";

function target(
  stablecoinId: string,
  retainedTvlUsd: number,
  suffix = stablecoinId,
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
  };
}

describe("measured execution overflow admission", () => {
  it("estimates batch, pool-binding, and singleton-retry request headroom per target", () => {
    expect(estimateTargetAdmissionRpcRequests(target("coin-low", 100_000))).toBe(2);
    expect(estimateTargetAdmissionRpcRequests(target("coin-high", 10_000_000))).toBe(3);
  });

  it("rotates the deterministic coin-level tail instead of starving it", () => {
    const targets = [target("coin-a", 100_000), target("coin-b", 100_000), target("coin-c", 100_000)];
    const first = admitTargetsWithinBudget(targets, {
      maxEstimatedRpcRequests: 2,
    });
    const second = admitTargetsWithinBudget(targets, {
      cursor: first.nextCursor,
      maxEstimatedRpcRequests: 2,
    });
    const third = admitTargetsWithinBudget(targets, {
      cursor: second.nextCursor,
      maxEstimatedRpcRequests: 2,
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
      target("coin-b", 10_000_000),
      target("coin-c", 100_000),
    ];
    const first = admitTargetsWithinBudget(targets, { maxEstimatedRpcRequests: 4 });
    const second = admitTargetsWithinBudget(targets, {
      cursor: first.nextCursor,
      maxEstimatedRpcRequests: 4,
    });
    const third = admitTargetsWithinBudget(targets, {
      cursor: second.nextCursor,
      maxEstimatedRpcRequests: 4,
    });

    expect([...first.admitted]).toEqual(["target-coin-b"]);
    expect([...second.admitted]).toEqual(["target-coin-a-1", "target-coin-a-2"]);
    expect([...third.admitted]).toEqual(["target-coin-c"]);
    expect(new Set([...first.admitted, ...second.admitted, ...third.admitted]).size).toBe(4);
  });

  it("surfaces an oversized coin group and continues admitting later groups", () => {
    const admission = admitTargetsWithinBudget(
      [
        target("coin-a", 100_000, "coin-a-1"),
        target("coin-a", 100_000, "coin-a-2"),
        target("coin-b", 100_000),
      ],
      { maxEstimatedRpcRequests: 3 },
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
        cursorWriteStatus: "written",
      }),
    ).toBe("ok");
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 0,
        deferredCount: 0,
        cursorWriteStatus: "missing-table",
      }),
    ).toBe("ok");
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 0,
        deferredCount: 2,
        cursorWriteStatus: "missing-table",
      }),
    ).toBe("degraded");
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 0,
        deferredCount: 2,
        cursorWriteStatus: "write-failed",
      }),
    ).toBe("degraded");
    expect(
      resolveMeasuredExecutionCronStatus({
        attemptedFailureCount: 1,
        deferredCount: 0,
        cursorWriteStatus: "not-needed",
      }),
    ).toBe("degraded");
  });

  it("attributes unresolved quoter work to a hard runtime budget stop", () => {
    expect(
      resolveMeasuredExecutionQuoteFailureReason(
        "quoter-rpc-unavailable",
        "request-budget-exhausted",
      ),
    ).toBe("request-budget-exhausted");
    expect(
      resolveMeasuredExecutionQuoteFailureReason("quoter-rpc-unavailable", null),
    ).toBe("quoter-rpc-unavailable");
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
