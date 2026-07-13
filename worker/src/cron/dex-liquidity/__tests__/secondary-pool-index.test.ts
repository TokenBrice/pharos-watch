import { describe, expect, it } from "vitest";

import { mergeGtPools } from "../fetch-crawlers";
import { initMetrics } from "../pool-helpers";
import type { GtNewPool, LiquidityMetrics, PoolEntry } from "../types";

function makePool(address: string, overrides: Partial<GtNewPool> = {}): GtNewPool {
  return {
    address,
    chain: "ethereum",
    dexId: "uniswap-v3",
    name: "USDC / USDT",
    tvlUsd: 100_000,
    volume24hUsd: 10_000,
    qualityMultiplier: 0.8,
    maturityDays: 30,
    price: 1,
    symbol: "USDC / USDT",
    poolType: "uniswap-v3-5bp",
    sourceFamily: "direct_api",
    ...overrides,
  };
}

function makePoolEntry(poolId: string): PoolEntry {
  return {
    poolId,
    project: "uniswap-v3",
    chain: "Ethereum",
    tvlUsd: 100_000,
    symbol: "USDC / USDT",
    volumeUsd1d: 10_000,
    poolType: "uniswap-v3-5bp",
    source: "direct_api",
  };
}

describe("secondary DEX pool merges", () => {
  it("retains duplicate execution evidence through the indexed merge path", async () => {
    const metrics = new Map<string, LiquidityMetrics>();
    const address = `0x${"1".repeat(40)}`;
    const basePool = makePool(address);
    const executionModel: NonNullable<GtNewPool["ammExecutionModel"]> = {
      source: "raydium",
      invariant: "constant-product",
      trackedTokenIndex: 0,
      feeRate: 0.0025,
      tokens: [
        {
          address: "UsdcMint",
          symbol: "USDC",
          decimals: 6,
          balance: 100_000,
          referencePriceUsd: 1,
          referencePriceSource: "tracked-market",
          trackedAssetId: "usdc-circle",
        },
        {
          address: "UsdtMint",
          symbol: "USDT",
          decimals: 6,
          balance: 100_000,
          referencePriceUsd: 1,
          referencePriceSource: "tracked-market",
          trackedAssetId: "usdt-tether",
        },
      ],
    };

    await mergeGtPools(metrics, new Map([["usdc-circle", [basePool]]]));
    await mergeGtPools(metrics, new Map([["usdc-circle", [{ ...basePool, ammExecutionModel: executionModel }]]]));

    const result = metrics.get("usdc-circle");
    expect(result?.poolCount).toBe(1);
    expect(result?.topPools).toHaveLength(1);
    expect(result?.topPools[0]?.extra?.ammExecutionModel).toEqual(executionModel);
  });

  it("indexes existing pool identities once for a large per-coin batch", async () => {
    const existingCount = 128;
    const metrics = initMetrics("usdc-circle", "USDC");
    let poolIdReads = 0;

    for (let index = 0; index < existingCount; index++) {
      const entry = makePoolEntry("");
      Object.defineProperty(entry, "poolId", {
        enumerable: true,
        get: () => {
          poolIdReads++;
          return `ethereum:0x${index.toString(16).padStart(40, "0")}`;
        },
      });
      metrics.topPools.push(entry);
    }

    const incoming = Array.from({ length: existingCount }, (_, index) =>
      makePool(`0x${(index + existingCount).toString(16).padStart(40, "0")}`),
    );

    await mergeGtPools(new Map([["usdc-circle", metrics]]), new Map([["usdc-circle", incoming]]));

    expect(poolIdReads).toBe(existingCount);
    expect(metrics.topPools).toHaveLength(existingCount * 2);
  });
});
