import { describe, expect, it } from "vitest";

import type { DexMeasuredExecutionPublicProfile } from "@shared/types/measured-execution";
import type { SolanaMeasuredExecutionPublicProfile } from "@shared/types/solana-measured-execution";
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
  it("keeps measured route evidence in the private candidate set without changing the current pool list", () => {
    const current = Array.from({ length: MAX_DEX_EXIT_ROUTE_OBSERVATIONS }, (_, index) => pool(index));
    const retained = pool(99);
    retained.extra = {
      measuredExecution: {
        targetId: "retained-target",
      } as DexMeasuredExecutionPublicProfile,
      measuredExecutionPhysicalPoolId: retained.poolId,
    };

    const selected = selectDexRouteObservationPools(current, [retained]);

    expect(selected).toHaveLength(MAX_DEX_EXIT_ROUTE_OBSERVATIONS + 1);
    expect(selected[0]?.poolId).toBe(retained.poolId);
    expect(current).toHaveLength(MAX_DEX_EXIT_ROUTE_OBSERVATIONS);
    expect(current).not.toContain(retained);
  });

  it("carries generic and exact pools into stress-capacity evaluation before the public bound", () => {
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

    expect(selected).toHaveLength(generic.length + 1);
    expect(selected[0]).toBe(exact);
    expect(selected).toContain(generic[MAX_DEX_EXIT_ROUTE_OBSERVATIONS + 4]);
  });

  it("ranks current exact evidence ahead of interrupted evidence without pre-capping candidates", () => {
    const interrupted = Array.from({ length: MAX_DEX_EXIT_ROUTE_OBSERVATIONS }, (_, index) => {
      const candidate = pool(index);
      candidate.extra = {
        measuredExecution: {
          targetId: `interrupted-target-${index}`,
          observationHistory: {
            completeProducerCycleCount: 3,
            successfulObservationCount: 2,
            consecutiveSuccessCount: 0,
            observationWindowStartedAt: 1_000,
            observationWindowEndedAt: 4_600,
            latestOperationalFailureAt: 4_600,
            conservativeStatistic: "pointwise-minimum",
            conservativeCapacityCurve: [100_000, 1_000_000, 10_000_000, 25_000_000].map(
              (requestedNotionalUsd) => ({
                requestedNotionalUsd,
                maxCostBps: 200,
                executableUsd: requestedNotionalUsd,
                completionRatio: 1,
              }),
            ),
          },
        } as DexMeasuredExecutionPublicProfile,
      };
      return candidate;
    });
    const exact = pool(99);
    exact.tvlUsd = 10_000;
    exact.extra = {
      ammExecutionModel: exactExecutionModel(),
    };

    const selected = selectDexRouteObservationPools([...interrupted, exact], []);

    expect(selected).toHaveLength(MAX_DEX_EXIT_ROUTE_OBSERVATIONS + 1);
    expect(selected[0]).toBe(exact);
    expect(selected).toEqual(expect.arrayContaining(interrupted));
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

  it("ranks an atomic multi-direction measured packet as one physical pool before observation packing", () => {
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

    expect(selected).toHaveLength(MAX_DEX_EXIT_ROUTE_OBSERVATIONS + 1);
    expect(selected[0]).toBe(measured);
    expect(selected.filter((candidate) => candidate.poolId === measured.poolId)).toHaveLength(1);
  });

  it("preserves case-sensitive non-EVM physical pool identities", () => {
    const upper = pool(1);
    upper.chain = "Solana";
    upper.poolId = "solana:AbCdEf123";
    const lower = pool(2);
    lower.chain = "Solana";
    lower.poolId = "solana:abcdef123";

    const selected = selectDexRouteObservationPools([upper, lower], []);

    expect(selected).toHaveLength(2);
    expect(selected).toEqual(expect.arrayContaining([upper, lower]));
  });

  it("prioritizes an active native measured profile in the private candidate set", () => {
    const current = Array.from({ length: MAX_DEX_EXIT_ROUTE_OBSERVATIONS }, (_, index) => pool(index));
    const native = pool(99);
    native.chain = "Solana";
    native.poolId = "solana:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
    native.extra = {
      nativeMeasuredExecution: {
        targetId: "native-target",
      } as SolanaMeasuredExecutionPublicProfile,
      nativeMeasuredExecutionPhysicalPoolId: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
    };

    const selected = selectDexRouteObservationPools(current, [native]);

    expect(selected).toHaveLength(MAX_DEX_EXIT_ROUTE_OBSERVATIONS + 1);
    expect(selected[0]).toBe(native);
  });
});
