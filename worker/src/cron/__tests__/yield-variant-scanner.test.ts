import { describe, expect, it } from "vitest";
import { scanForNewVariants } from "../yield-sync/resolve";
import type { DlPool } from "../yield-sync/types";
import { makeDlYieldPool } from "./yield-resolve.test-support";

describe("scanForNewVariants", () => {
  const knownVariants = new Set(["SUSDE", "SDAI", "SUSDS"]);

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

  it("discovers suffix variants at the TVL boundary and deduplicates mixed case", () => {
    // C20 — the duplicate that survives is the deepest pool, not DeFiLlama's first row.
    const results = scanForNewVariants([
      makeDlYieldPool({ pool: "smaller", symbol: "USDCEarn", tvlUsd: 500_000 }),
      makeDlYieldPool({ pool: "larger", symbol: "usdceARN", tvlUsd: 900_000 }),
    ], new Set(["USDC"]), knownVariants);
    expect(results).toEqual([{
      baseSymbol: "USDC", variantSymbol: "usdceARN", poolId: "larger",
      chain: "Ethereum", project: "maker", tvlUsd: 900_000, apy: 5,
    }]);
  });
});
