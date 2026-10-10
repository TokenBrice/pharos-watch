import { describe, expect, it } from "vitest";
import { compareLiquidityRows, type LiquidityRow, type LiquiditySortKey } from "@/components/liquidity-table-logic";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import type { DexLiquidityData } from "@shared/types";
import type { StablecoinClientMeta } from "@shared/types/stablecoin-client-meta";

function makeRow(overrides: Partial<DexLiquidityData> = {}): LiquidityRow {
  return {
    meta: { id: "usdc", symbol: "USDC", name: "USD Coin", listingClass: "core-stablecoin" } as StablecoinClientMeta,
    liq: makeDexLiquidityData(overrides),
  };
}

const numericKeys = [
  ["score", "liquidityScore"],
  ["tvl", "totalTvlUsd"],
  ["tvlTrend", "tvlChange7d"],
  ["volume", "totalVolume24hUsd"],
  ["volume7d", "totalVolume7dUsd"],
  ["pools", "poolCount"],
  ["chains", "chainCount"],
  ["balance", "weightedBalanceRatio"],
  ["organic", "organicFraction"],
  ["durability", "durabilityScore"],
] as const;

describe("compareLiquidityRows", () => {
  it.each(["asc", "desc"] as const)("sorts NR after observed zero scores (%s)", (direction) => {
    const missing = makeRow({ liquidityScore: null });
    const zero = makeRow({ liquidityScore: 0 });
    expect(compareLiquidityRows(missing, zero, { key: "score", direction })).toBeGreaterThan(0);
    expect(compareLiquidityRows(zero, missing, { key: "score", direction })).toBeLessThan(0);
  });

  it.each(numericKeys)("sorts %s in both directions", (key, field) => {
    const fractional = key === "balance" || key === "organic";
    const high = makeRow({ [field]: fractional ? 0.9 : 9 });
    const low = makeRow({ [field]: fractional ? 0.1 : 1 });
    expect(compareLiquidityRows(high, low, { key, direction: "desc" })).toBeLessThan(0);
    expect(compareLiquidityRows(high, low, { key, direction: "asc" })).toBeGreaterThan(0);
  });

  it.each([
    ["tvlTrend", "tvlChange7d"],
    ["balance", "weightedBalanceRatio"],
    ["organic", "organicFraction"],
    ["durability", "durabilityScore"],
  ] as const)("treats null %s as zero", (key, field) => {
    const missing = makeRow({ [field]: null });
    const zero = makeRow({ [field]: 0 });
    const positive = makeRow({ [field]: 0.1 });
    expect(compareLiquidityRows(missing, zero, { key, direction: "desc" })).toBe(0);
    expect(compareLiquidityRows(positive, missing, { key, direction: "desc" })).toBeLessThan(0);
  });

  it.each(["volume", "volume7d", "vtRatio"] as const)(
    "sorts unavailable %s after a measured zero in both directions",
    (key) => {
      const unavailable = makeRow({ totalTvlUsd: 1_000, totalVolume24hUsd: null, totalVolume7dUsd: null });
      const measuredZero = makeRow({ totalTvlUsd: 1_000, totalVolume24hUsd: 0, totalVolume7dUsd: 0 });
      expect(compareLiquidityRows(unavailable, measuredZero, { key, direction: "desc" })).toBeGreaterThan(0);
      expect(compareLiquidityRows(unavailable, measuredZero, { key, direction: "asc" })).toBeGreaterThan(0);
    },
  );

  it("sorts volume/TVL ratios rather than absolute volume", () => {
    const highRatio = makeRow({ totalVolume24hUsd: 100, totalTvlUsd: 200 });
    const lowRatio = makeRow({ totalVolume24hUsd: 200, totalTvlUsd: 1_000 });
    expect(compareLiquidityRows(highRatio, lowRatio, { key: "vtRatio", direction: "desc" })).toBeLessThan(0);
  });

  it("treats zero TVL as a zero ratio", () => {
    const positive = makeRow({ totalVolume24hUsd: 100, totalTvlUsd: 1_000 });
    const zeroTvl = makeRow({ totalVolume24hUsd: 100, totalTvlUsd: 0 });
    expect(compareLiquidityRows(positive, zeroTvl, { key: "vtRatio", direction: "desc" })).toBeLessThan(0);
  });

  it("returns zero for an unknown sort key", () => {
    expect(compareLiquidityRows(makeRow({ liquidityScore: 80 }), makeRow({ liquidityScore: 20 }), {
      key: "unknown" as LiquiditySortKey, direction: "desc",
    })).toBe(0);
  });
});
