import { describe, expect, it } from "vitest";

import type { DexMeasuredExecutionPublicProfile } from "@shared/types/measured-execution";
import { MAX_DEX_EXIT_ROUTE_OBSERVATIONS } from "@shared/types/market";
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

function exactExecutionModel(): NonNullable<NonNullable<PoolEntry["extra"]>["ammExecutionModel"]> {
  return {
    source: "uniswap-v2",
    invariant: "constant-product",
    trackedTokenIndex: 0,
    feeRate: 0.003,
    tokens: [
      {
        address: "0x0000000000000000000000000000000000000011",
        symbol: "USDC",
        decimals: 6,
        balance: 500_000,
        referencePriceUsd: 1,
        referencePriceSource: "tracked-market",
        trackedAssetId: "usdc-circle",
      },
      {
        address: "0x0000000000000000000000000000000000000012",
        symbol: "USDT",
        decimals: 6,
        balance: 500_000,
        referencePriceUsd: 1,
        referencePriceSource: "tracked-market",
        trackedAssetId: "usdt-tether",
      },
    ],
  };
}

describe("DEX route observation selection", () => {
  it("keeps measured route evidence inside the bounded route set without changing the current pool list", () => {
    const current = Array.from({ length: MAX_DEX_EXIT_ROUTE_OBSERVATIONS }, (_, index) => pool(index));
    const retained = pool(99);
    retained.extra = {
      measuredExecution: {
        targetId: "retained-target",
      } as DexMeasuredExecutionPublicProfile,
      measuredExecutionPhysicalPoolId: retained.poolId,
    };

    const selected = selectDexRouteObservationPools(current, [retained]);

    expect(selected).toHaveLength(MAX_DEX_EXIT_ROUTE_OBSERVATIONS);
    expect(selected[0]?.poolId).toBe(retained.poolId);
    expect(current).toHaveLength(MAX_DEX_EXIT_ROUTE_OBSERVATIONS);
    expect(current).not.toContain(retained);
  });

  it("does not let generic retained pools crowd score-capable exact evidence out of the bound", () => {
    const generic = Array.from({ length: MAX_DEX_EXIT_ROUTE_OBSERVATIONS + 5 }, (_, index) => {
      const candidate = pool(index);
      candidate.tvlUsd = 100_000_000 - index;
      return candidate;
    });
    const exact = pool(99);
    exact.tvlUsd = 10_000;
    exact.extra = {
      ammExecutionModel: exactExecutionModel(),
    };

    const selected = selectDexRouteObservationPools([...generic, exact], []);

    expect(selected).toHaveLength(MAX_DEX_EXIT_ROUTE_OBSERVATIONS);
    expect(selected[0]).toBe(exact);
    expect(selected).not.toContain(generic[MAX_DEX_EXIT_ROUTE_OBSERVATIONS + 4]);
  });

  it("deduplicates by physical pool and keeps measured evidence ahead of current exact evidence", () => {
    const current = pool(1);
    current.extra = {
      ammExecutionModel: exactExecutionModel(),
    };
    const retained = {
      ...pool(2),
      extra: {
        measuredExecution: {
          targetId: "retained-target",
        } as DexMeasuredExecutionPublicProfile,
        measuredExecutionPhysicalPoolId: current.poolId,
      },
    } satisfies PoolEntry;

    const selected = selectDexRouteObservationPools([current], [retained]);

    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(retained);
  });

  it("ranks an atomic multi-direction measured packet as one physical pool", () => {
    const current = Array.from({ length: MAX_DEX_EXIT_ROUTE_OBSERVATIONS }, (_, index) => pool(index));
    const measured = pool(99);
    measured.extra = {
      measuredExecutions: [
        { targetId: "curve-3pool-usdt-dai" },
        { targetId: "curve-3pool-usdt-usdc" },
      ] as DexMeasuredExecutionPublicProfile[],
      measuredExecutionPhysicalPoolId: measured.poolId,
    };

    const selected = selectDexRouteObservationPools(current, [measured]);

    expect(selected).toHaveLength(MAX_DEX_EXIT_ROUTE_OBSERVATIONS);
    expect(selected[0]).toBe(measured);
    expect(selected.filter((candidate) => candidate.poolId === measured.poolId)).toHaveLength(1);
  });
});
