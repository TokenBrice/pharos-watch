import { describe, expect, it } from "vitest";
import { compareLiquidityRows, type LiquidityRow } from "@/components/liquidity-table-logic";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import type { DexLiquidityData } from "@shared/types";
import type { StablecoinClientMeta } from "@shared/types/stablecoin-client-meta";

function makeRow(overrides: Partial<DexLiquidityData> = {}): LiquidityRow {
  return {
    meta: { id: "usdc", symbol: "USDC", name: "USD Coin", listingClass: "core-stablecoin" } as StablecoinClientMeta,
    liq: makeDexLiquidityData(overrides),
  };
}

describe("compareLiquidityRows", () => {
  it.each(["asc", "desc"] as const)("sorts NR after observed zero scores (%s)", (direction) => {
    const missing = makeRow({ liquidityScore: null });
    const zero = makeRow({ liquidityScore: 0 });
    expect(compareLiquidityRows(missing, zero, { key: "score", direction })).toBeGreaterThan(0);
    expect(compareLiquidityRows(zero, missing, { key: "score", direction })).toBeLessThan(0);
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

  it.each([
    ["tvlTrend", "tvlChange7d"],
    ["balance", "weightedBalanceRatio"],
    ["organic", "organicFraction"],
    ["durability", "durabilityScore"],
  ] as const)("sorts unavailable %s last within both rating groups", (key, field) => {
    for (const liquidityScore of [null, 50]) {
      const rows = [null, 0, 0.5, -0.5].map((value) => makeRow({ liquidityScore, [field]: value }));
      for (const direction of ["asc", "desc"] as const) {
        const sorted = [...rows].sort((a, b) => compareLiquidityRows(a, b, { key, direction }));
        expect(sorted.map(({ liq }) => liq[field])).toEqual(
          direction === "asc" ? [-0.5, 0, 0.5, null] : [0.5, 0, -0.5, null],
        );
        expect(compareLiquidityRows(rows[0], rows[0], { key, direction })).toBe(0);
      }
    }
  });

  it("sorts volume/TVL ratios rather than absolute volume", () => {
    const highRatio = makeRow({ totalVolume24hUsd: 100, totalTvlUsd: 200 });
    const lowRatio = makeRow({ totalVolume24hUsd: 200, totalTvlUsd: 1_000 });
    expect(compareLiquidityRows(highRatio, lowRatio, { key: "vtRatio", direction: "desc" })).toBeLessThan(0);
  });

  it.each(["asc", "desc"] as const)("keeps NR rows after rated rows on every column (%s)", (direction) => {
    const deepNr = makeRow({ liquidityScore: null, totalTvlUsd: 1_000_000 });
    const shallowRated = makeRow({ liquidityScore: 10, totalTvlUsd: 1 });
    expect(compareLiquidityRows(deepNr, shallowRated, { key: "tvl", direction })).toBeGreaterThan(0);
    expect(compareLiquidityRows(shallowRated, deepNr, { key: "tvl", direction })).toBeLessThan(0);
    const smallerNr = makeRow({ liquidityScore: null, totalTvlUsd: 10 });
    expect(Math.sign(compareLiquidityRows(deepNr, smallerNr, { key: "tvl", direction }))).toBe(direction === "desc" ? -1 : 1);
    for (const key of [
      "score", "tvl", "tvlTrend", "volume", "volume7d", "vtRatio",
      "pools", "chains", "balance", "organic", "durability",
    ] as const) {
      expect(compareLiquidityRows(deepNr, shallowRated, { key, direction })).toBeGreaterThan(0);
      expect(compareLiquidityRows(shallowRated, deepNr, { key, direction })).toBeLessThan(0);
    }
  });

  it("treats zero TVL as a zero ratio", () => {
    const positive = makeRow({ totalVolume24hUsd: 100, totalTvlUsd: 1_000 });
    const zeroTvl = makeRow({ totalVolume24hUsd: 100, totalTvlUsd: 0 });
    expect(compareLiquidityRows(positive, zeroTvl, { key: "vtRatio", direction: "desc" })).toBeLessThan(0);
  });

});
