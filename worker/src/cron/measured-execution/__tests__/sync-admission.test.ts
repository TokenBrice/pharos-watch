import { describe, expect, it } from "vitest";

import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { admitTargetsWithinBudget, resolveMeasuredExecutionCronStatus } from "../sync";

function target(stablecoinId: string, retainedTvlUsd: number): DexMeasuredExecutionTarget {
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId: `target-${stablecoinId}`,
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
  it("rotates the deterministic coin-level tail instead of starving it", () => {
    const targets = [target("coin-a", 100_000), target("coin-b", 100_000), target("coin-c", 100_000)];
    const first = admitTargetsWithinBudget(targets, {
      maxQuoteCalls: 5,
      refinementRounds: 3,
    });
    const second = admitTargetsWithinBudget(targets, {
      cursor: first.nextCursor,
      maxQuoteCalls: 5,
      refinementRounds: 3,
    });
    const third = admitTargetsWithinBudget(targets, {
      cursor: second.nextCursor,
      maxQuoteCalls: 5,
      refinementRounds: 3,
    });

    expect([...first.admitted]).toEqual(["target-coin-a"]);
    expect([...second.admitted]).toEqual(["target-coin-b"]);
    expect([...third.admitted]).toEqual(["target-coin-c"]);
    expect(first.deferred.size).toBe(2);
    expect(second.deferred.size).toBe(2);
    expect(third.deferred.size).toBe(2);
  });

  it("degrades on durable cursor write failure but not missing-table rollout compatibility", () => {
    expect(resolveMeasuredExecutionCronStatus({ failedCount: 0, cursorWriteStatus: "write-failed" })).toBe("degraded");
    expect(resolveMeasuredExecutionCronStatus({ failedCount: 0, cursorWriteStatus: "missing-table" })).toBe("ok");
    expect(resolveMeasuredExecutionCronStatus({ failedCount: 1, cursorWriteStatus: "written" })).toBe("degraded");
  });
});
