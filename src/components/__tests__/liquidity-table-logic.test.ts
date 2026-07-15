import { describe, expect, it } from "vitest";
import {
  compareLiquidityRows,
  type LiquidityRow,
  type LiquiditySortKey,
} from "@/components/liquidity-table-logic";
import type { DexLiquidityData } from "@shared/types";
import type { StablecoinClientMeta } from "@shared/types/stablecoin-client-meta";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";

function makeRow(overrides: Partial<DexLiquidityData> = {}): LiquidityRow {
  return {
    meta: {
      id: "usdc",
      symbol: "USDC",
      name: "USD Coin",
      listingClass: "core-stablecoin",
    } as StablecoinClientMeta,
    liq: {
      totalTvlUsd: 1_000_000,
      totalVolume24hUsd: 100_000,
      totalVolume7dUsd: 700_000,
      tvlChange7d: 0,
      poolCount: 5,
      pairCount: 5,
      chainCount: 3,
      protocolTvl: {},
      chainTvl: {},
      topPools: [],
      liquidityScore: 50,
      concentrationHhi: null,
      depthStability: null,
      tvlChange24h: null,
      updatedAt: 0,
      dexPriceUsd: null,
      dexDeviationBps: null,
      priceSourceCount: null,
      priceSourceTvl: null,
      priceSources: null,
      effectiveTvlUsd: 1_000_000,
      avgPoolStress: null,
      weightedBalanceRatio: 0.5,
      organicFraction: 0.8,
      durabilityScore: 60,
      coverageClass: "primary",
      coverageConfidence: 1,
      sourceMix: {},
      balanceMeasuredTvlUsd: 1_000_000,
      organicMeasuredTvlUsd: 800_000,
      scoreComponents: null,
      methodologyVersion: "v1",
      ...overrides,
    } as DexLiquidityData,
  };
}

const sort = (key: LiquiditySortKey, direction: "asc" | "desc" = "desc"): TableSortState<LiquiditySortKey> => ({
  key,
  direction,
});

describe("compareLiquidityRows — score", () => {
  it("sorts by liquidity score descending", () => {
    const high = makeRow({ liquidityScore: 90 });
    const low = makeRow({ liquidityScore: 10 });
    const result = compareLiquidityRows(high, low, sort("score", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("sorts by liquidity score ascending", () => {
    const high = makeRow({ liquidityScore: 90 });
    const low = makeRow({ liquidityScore: 10 });
    const result = compareLiquidityRows(high, low, sort("score", "asc"));
    expect(result).toBeGreaterThan(0);
  });

  it("treats null score as 0", () => {
    const hasScore = makeRow({ liquidityScore: 1 });
    const nullScore = makeRow({ liquidityScore: null });
    const result = compareLiquidityRows(hasScore, nullScore, sort("score", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — tvl", () => {
  it("sorts by TVL descending", () => {
    const big = makeRow({ totalTvlUsd: 1_000_000_000 });
    const small = makeRow({ totalTvlUsd: 1_000 });
    const result = compareLiquidityRows(big, small, sort("tvl", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("sorts by TVL ascending", () => {
    const big = makeRow({ totalTvlUsd: 1_000_000_000 });
    const small = makeRow({ totalTvlUsd: 1_000 });
    const result = compareLiquidityRows(big, small, sort("tvl", "asc"));
    expect(result).toBeGreaterThan(0);
  });
});

describe("compareLiquidityRows — tvlTrend", () => {
  it("sorts by 7d TVL change descending", () => {
    const growing = makeRow({ tvlChange7d: 0.15 });
    const shrinking = makeRow({ tvlChange7d: -0.1 });
    const result = compareLiquidityRows(growing, shrinking, sort("tvlTrend", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("treats null tvlChange7d as 0", () => {
    const hasChange = makeRow({ tvlChange7d: 0.1 });
    const nullChange = makeRow({ tvlChange7d: null });
    const result = compareLiquidityRows(hasChange, nullChange, sort("tvlTrend", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — volume", () => {
  it("sorts by 24h volume descending", () => {
    const high = makeRow({ totalVolume24hUsd: 5_000_000 });
    const low = makeRow({ totalVolume24hUsd: 100_000 });
    const result = compareLiquidityRows(high, low, sort("volume", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — volume7d", () => {
  it("sorts by 7d volume descending", () => {
    const high = makeRow({ totalVolume7dUsd: 50_000_000 });
    const low = makeRow({ totalVolume7dUsd: 1_000_000 });
    const result = compareLiquidityRows(high, low, sort("volume7d", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — vtRatio (volume/TVL)", () => {
  it("sorts by V/T ratio descending", () => {
    // high V/T: 500k / 1M = 0.5
    const highRatio = makeRow({ totalVolume24hUsd: 500_000, totalTvlUsd: 1_000_000 });
    // low V/T: 10k / 1M = 0.01
    const lowRatio = makeRow({ totalVolume24hUsd: 10_000, totalTvlUsd: 1_000_000 });
    const result = compareLiquidityRows(highRatio, lowRatio, sort("vtRatio", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("treats zero TVL as 0 ratio", () => {
    const hasRatio = makeRow({ totalVolume24hUsd: 100_000, totalTvlUsd: 1_000_000 });
    const zeroTvl = makeRow({ totalVolume24hUsd: 100_000, totalTvlUsd: 0 });
    const result = compareLiquidityRows(hasRatio, zeroTvl, sort("vtRatio", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — pools", () => {
  it("sorts by pool count descending", () => {
    const many = makeRow({ poolCount: 100 });
    const few = makeRow({ poolCount: 2 });
    const result = compareLiquidityRows(many, few, sort("pools", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — chains", () => {
  it("sorts by chain count descending", () => {
    const multichain = makeRow({ chainCount: 10 });
    const single = makeRow({ chainCount: 1 });
    const result = compareLiquidityRows(multichain, single, sort("chains", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — balance", () => {
  it("sorts by weighted balance ratio descending", () => {
    const balanced = makeRow({ weightedBalanceRatio: 0.9 });
    const unbalanced = makeRow({ weightedBalanceRatio: 0.2 });
    const result = compareLiquidityRows(balanced, unbalanced, sort("balance", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("treats null weightedBalanceRatio as 0", () => {
    const hasRatio = makeRow({ weightedBalanceRatio: 0.1 });
    const nullRatio = makeRow({ weightedBalanceRatio: null });
    const result = compareLiquidityRows(hasRatio, nullRatio, sort("balance", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — organic", () => {
  it("sorts by organic fraction descending", () => {
    const high = makeRow({ organicFraction: 0.95 });
    const low = makeRow({ organicFraction: 0.1 });
    const result = compareLiquidityRows(high, low, sort("organic", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("treats null organicFraction as 0", () => {
    const hasFrac = makeRow({ organicFraction: 0.01 });
    const nullFrac = makeRow({ organicFraction: null });
    const result = compareLiquidityRows(hasFrac, nullFrac, sort("organic", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — durability", () => {
  it("sorts by durability score descending", () => {
    const durable = makeRow({ durabilityScore: 85 });
    const fragile = makeRow({ durabilityScore: 15 });
    const result = compareLiquidityRows(durable, fragile, sort("durability", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("treats null durabilityScore as 0", () => {
    const hasScore = makeRow({ durabilityScore: 1 });
    const nullScore = makeRow({ durabilityScore: null });
    const result = compareLiquidityRows(hasScore, nullScore, sort("durability", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareLiquidityRows — default fallback", () => {
  it("returns 0 for unknown key", () => {
    const high = makeRow({ liquidityScore: 80 });
    const low = makeRow({ liquidityScore: 20 });
    const result = compareLiquidityRows(high, low, { key: "unknown" as LiquiditySortKey, direction: "desc" });
    expect(result).toBe(0);
  });
});
