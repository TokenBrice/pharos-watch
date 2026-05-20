import { describe, expect, it } from "vitest";
import { adaptUsdgoTransparency } from "../usdgo-transparency";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";

describe("adaptUsdgoTransparency", () => {
  it("maps USDGO transparency buckets and preserves proof-class provenance", () => {
    const result = adaptUsdgoTransparency({
      ok: true,
      data: {
        collateralizationRatio: 100.18,
        buidlUsdM: "166.07",
        gsUsdM: "149.56",
        jltxxUsdM: "100.00",
        usdUsdM: "2.10",
        backingAssetsM: "417.73",
        circulationSupplyMFormatted: "417.00",
        lastUpdated: "May 13, 2026",
      },
    });

    expect(result.slices).toEqual([
      { name: "BlackRock BUIDL", pct: 39.8, risk: "low", coinId: "buidl-blackrock" },
      { name: "Goldman Sachs Stablecoin Reserves Fund (STBXX)", pct: 35.8, risk: "low" },
      { name: "JPMorgan OnChain Liquidity-Token Money Market Fund (JLTXX)", pct: 23.9, risk: "low" },
      { name: "Cash / USD deposits", pct: 0.5, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 4, 13) / 1000,
      freshnessMode: "verified",
      supplyUsd: 417_000_000,
      componentTotalUsd: 417_730_000,
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(417_730_000);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(417_730_000 / 417_000_000);
  });

  it("accepts current excess-percent collateralization ratio field", () => {
    const result = adaptUsdgoTransparency({
      ok: true,
      data: {
        collateralizationRatio: 0.27,
        buidlUsdM: "92.15",
        gsUsdM: "149.63",
        jltxxUsdM: "100.05",
        usdUsdM: "1.64",
        backingAssetsM: "343.46",
        circulationSupplyMFormatted: "342.54",
        lastUpdated: "May 18, 2026",
      },
    });

    expect(result.metadata?.publishedCollateralizationRatio).toBeCloseTo(1.0027);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(343_460_000 / 342_540_000);
    expect(result.metadata).toMatchObject({
      publishedCollateralizationRatioFormat: "excess-percent",
      sourceTimestamp: Date.UTC(2026, 4, 18) / 1000,
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "usdgo-collateralization-ratio-excess-percent",
        severity: "info",
      }),
    ]);
  });

  it("accepts a raw-ratio collateralization field when it matches reserves and supply", () => {
    const result = adaptUsdgoTransparency({
      ok: true,
      data: {
        collateralizationRatio: 1.002686,
        buidlUsdM: "92.15",
        gsUsdM: "149.63",
        jltxxUsdM: "100.05",
        usdUsdM: "1.64",
        backingAssetsM: "343.46",
        circulationSupplyMFormatted: "342.54",
        lastUpdated: "May 18, 2026",
      },
    });

    expect(result.metadata).toMatchObject({
      publishedCollateralizationRatioFormat: "raw-ratio",
    });
    expect(result.metadata?.publishedCollateralizationRatio).toBeCloseTo(1.002686);
    expect(result.warnings).toBeUndefined();
  });

  it("fails closed when components do not reconcile", () => {
    expect(() =>
      adaptUsdgoTransparency({
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
      }),
    ).toThrow("reserve components sum");
  });

  it("throws when ok is false (parse-failure path)", () => {
    expect(() => adaptUsdgoTransparency({ ok: false })).toThrow(/invalid response/);
    expect(() => adaptUsdgoTransparency({ ok: true, data: undefined })).toThrow(/invalid response/);
  });

  it("throws when any bucket value is not a number (parse-failure guard)", () => {
    expect(() =>
      adaptUsdgoTransparency({
        ok: true,
        data: {
          buidlUsdM: "not-a-number",
          gsUsdM: "0",
          usdUsdM: "0",
          backingAssetsM: "100",
          circulationSupplyMFormatted: "100",
          lastUpdated: "Apr 13, 2026",
        },
      }),
    ).toThrow(/invalid buidlUsdM/);
  });

  it("falls back to unverified freshness when lastUpdated is missing", () => {
    const result = adaptUsdgoTransparency({
      ok: true,
      data: {
        buidlUsdM: "55",
        gsUsdM: "44.5",
        usdUsdM: "0.5",
        backingAssetsM: "100",
        circulationSupplyMFormatted: "100",
      },
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });

  it("is rejected by validateAdapterOutput when the lastUpdated date is in the future", () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const month = future.toLocaleString("en-US", { month: "short" });
    const day = future.getUTCDate();
    const year = future.getUTCFullYear();
    const result = adaptUsdgoTransparency({
      ok: true,
      data: {
        buidlUsdM: "55",
        gsUsdM: "44.5",
        usdUsdM: "0.5",
        backingAssetsM: "100",
        circulationSupplyMFormatted: "100",
        lastUpdated: `${month} ${day}, ${year}`,
      },
    });
    const adapter = getReserveAdapter("usdgo-transparency") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });
    expect(report.valid).toBe(false);
  });
});
