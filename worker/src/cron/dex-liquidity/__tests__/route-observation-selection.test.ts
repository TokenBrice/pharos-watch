import { describe, expect, it } from "vitest";

import type { DexMeasuredExecutionPublicProfile } from "@shared/types/measured-execution";
import { selectDexRouteObservationPools } from "../scoring";
import type { PoolEntry } from "../types";

function pool(index: number): PoolEntry {
  return {
    poolId: `ethereum:0x${index.toString(16).padStart(40, "0")}`,
    project: "uniswap-v4",
    chain: "Ethereum",
    tvlUsd: 1_000_000 + index,
    symbol: `TOKEN-${index}`,
    volumeUsd1d: 1_000_000 + index,
    poolType: "generic",
    source: "dl",
  };
}

describe("DEX route observation selection", () => {
  it("keeps measured route evidence inside the bounded route set without changing the current pool list", () => {
    const current = Array.from({ length: 10 }, (_, index) => pool(index));
    const retained = pool(99);
    retained.extra = {
      measuredExecution: {
        targetId: "retained-target",
      } as DexMeasuredExecutionPublicProfile,
      measuredExecutionPhysicalPoolId: retained.poolId,
    };

    const selected = selectDexRouteObservationPools(current, [retained]);

    expect(selected).toHaveLength(10);
    expect(selected[0]?.poolId).toBe(retained.poolId);
    expect(current).toHaveLength(10);
    expect(current).not.toContain(retained);
  });

  it("deduplicates a retained route when the physical pool is already current", () => {
    const current = pool(1);
    const retained = {
      ...current,
      extra: {
        measuredExecution: {
          targetId: "retained-target",
        } as DexMeasuredExecutionPublicProfile,
        measuredExecutionPhysicalPoolId: current.poolId,
      },
    } satisfies PoolEntry;

    expect(selectDexRouteObservationPools([current], [retained])).toHaveLength(1);
  });
});
