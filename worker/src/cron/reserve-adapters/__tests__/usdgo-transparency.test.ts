import { describe, expect, it } from "vitest";
import { adaptUsdgoTransparency } from "../usdgo-transparency";

describe("adaptUsdgoTransparency", () => {
  it("maps USDGO transparency buckets and preserves proof-class provenance", () => {
    const result = adaptUsdgoTransparency({
      ok: true,
      data: {
        collateralizationRatio: 100.16,
        buidlUsdM: "73.82",
        gsUsdM: "59.72",
        usdUsdM: "0.67",
        backingAssetsM: "134.21",
        circulationSupplyMFormatted: "134.00",
        lastUpdated: "Apr 13, 2026",
      },
    });

    expect(result.slices).toEqual([
      { name: "BlackRock BUIDL", pct: 55, risk: "low", coinId: "buidl-blackrock" },
      { name: "Goldman Sachs Stablecoin Reserves Fund (STBXX)", pct: 44.5, risk: "low" },
      { name: "Cash / USD deposits", pct: 0.5, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 3, 13) / 1000,
      freshnessMode: "verified",
      supplyUsd: 134_000_000,
      componentTotalUsd: 134_210_000,
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(134_210_000);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(134_210_000 / 134_000_000);
  });

  it("fails closed when components do not reconcile", () => {
    expect(() => adaptUsdgoTransparency({
      ok: true,
      data: {
        collateralizationRatio: 100,
        buidlUsdM: "70",
        gsUsdM: "20",
        usdUsdM: "1",
        backingAssetsM: "100",
        circulationSupplyMFormatted: "100",
        lastUpdated: "Apr 13, 2026",
      },
    })).toThrow("reserve components sum");
  });
});
