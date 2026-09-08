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
  it.each(numericKeys)("sorts %s in both directions", (key, field) => {
    const fractional = key === "balance" || key === "organic";
    const high = makeRow({ [field]: fractional ? 0.9 : 9 });
    const low = makeRow({ [field]: fractional ? 0.1 : 1 });
    expect(compareLiquidityRows(high, low, { key, direction: "desc" })).toBeLessThan(0);
    expect(compareLiquidityRows(high, low, { key, direction: "asc" })).toBeGreaterThan(0);
  });

  it.each([
    ["score", "liquidityScore"],
    ["tvlTrend", "tvlChange7d"],
    ["volume7d", "totalVolume7dUsd"],
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
