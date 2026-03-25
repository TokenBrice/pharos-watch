import { describe, expect, it } from "vitest";
import { scanForNewVariants } from "../yield-sync/variant-scanner";
import type { DlPool } from "../yield-sync/types";

describe("scanForNewVariants", () => {
  const knownVariants = new Set(["SUSDE", "SDAI", "SUSDS"]);

  it("detects sXXX prefix pattern for a tracked symbol", () => {
    const pools: DlPool[] = [{
      pool: "new-pool", chain: "Ethereum", project: "some-protocol",
      symbol: "sFRAX", tvlUsd: 5_000_000, apy: 3.5, apyBase: 3.5,
      apyReward: null, apyMean30d: 3.5, stablecoin: false,
      exposure: "single", underlyingTokens: null,
    }];
    const trackedSymbols = new Set(["FRAX", "USDC", "USDE"]);
    const results = scanForNewVariants(pools, trackedSymbols, knownVariants);
    expect(results).toContainEqual(expect.objectContaining({
      baseSymbol: "FRAX",
      variantSymbol: "sFRAX",
      poolId: "new-pool",
    }));
  });

  it("skips variants already in the known set", () => {
    const pools: DlPool[] = [{
      pool: "existing", chain: "Ethereum", project: "ethena",
      symbol: "sUSDe", tvlUsd: 3_000_000_000, apy: 4.0, apyBase: 4.0,
      apyReward: null, apyMean30d: 4.0, stablecoin: false,
      exposure: "single", underlyingTokens: null,
    }];
    const trackedSymbols = new Set(["USDE"]);
    const results = scanForNewVariants(pools, trackedSymbols, knownVariants);
    expect(results).toEqual([]);
  });

  it("requires minimum TVL to avoid noise", () => {
    const pools: DlPool[] = [{
      pool: "tiny", chain: "Ethereum", project: "unknown",
      symbol: "sUSDC", tvlUsd: 1_000, apy: 10, apyBase: 10,
      apyReward: null, apyMean30d: 10, stablecoin: false,
      exposure: "single", underlyingTokens: null,
    }];
    const trackedSymbols = new Set(["USDC"]);
    const results = scanForNewVariants(pools, trackedSymbols, knownVariants);
    expect(results).toEqual([]);
  });
});
