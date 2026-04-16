import { describe, expect, it } from "vitest";
import { adaptReservoirReserves, fetchReservoirReserves, type ReservoirReservesResponse } from "../reservoir";

const SAMPLE_RESPONSE: ReservoirReservesResponse = {
  assets: [
    { label: "Dolomite - USD1", totalBalanceValue: "30" },
    { label: "Euler - Sentora PYUSD", totalBalanceValue: "20" },
    { label: "Morpho - Sentora PYUSD Main V2", totalBalanceValue: "10" },
    { label: "Euler - Sentora RLUSD", totalBalanceValue: "15" },
    { label: "Aave - sGHO", totalBalanceValue: "10" },
    { label: "Fluid - USDT0 (Plasma)", totalBalanceValue: "10" },
    { label: "USDC", totalBalanceValue: "5" },
  ],
  liabilities: [],
  totalAssets: "100",
  totalLiabilities: "95",
  equity: "5",
};

describe("adaptReservoirReserves", () => {
  it("groups live balance-sheet assets into reserve slices", () => {
    const { slices, immediateRedeemableUsd, supplyUsd, unknownExposurePct } = adaptReservoirReserves(SAMPLE_RESPONSE);

    expect(slices).toEqual([
      { name: "USD1 lending markets", pct: 30, risk: "medium", coinId: "usd1-world-liberty-financial", depType: "wrapper" },
      { name: "PYUSD lending markets", pct: 30, risk: "medium", coinId: "pyusd-paypal", depType: "wrapper" },
      { name: "RLUSD lending markets", pct: 15, risk: "medium", coinId: "rlusd-ripple", depType: "wrapper" },
      { name: "GHO lending markets", pct: 10, risk: "medium", coinId: "gho-aave", depType: "wrapper" },
      { name: "USDT / USDT0 positions", pct: 10, risk: "medium", coinId: "usdt-tether", depType: "wrapper" },
      { name: "USDC positions", pct: 5, risk: "medium", coinId: "usdc-circle", depType: "wrapper" },
    ]);
    // All stable buckets count toward immediate redemption capacity, not just USDC.
    expect(immediateRedeemableUsd).toBe(100);
    expect(supplyUsd).toBe(95);
    expect(unknownExposurePct).toBe(0);
  });

  it("returns empty slices for zero total assets", () => {
    const { slices } = adaptReservoirReserves({
      assets: [],
      liabilities: [],
      totalAssets: "0",
      totalLiabilities: "0",
      equity: "0",
    });
    expect(slices).toHaveLength(0);
  });

  it("returns empty slices for NaN total assets", () => {
    const { slices } = adaptReservoirReserves({
      assets: [{ label: "USDC", totalBalanceValue: "100" }],
      liabilities: [],
      totalAssets: "not-a-number",
      totalLiabilities: "0",
      equity: "0",
    });
    expect(slices).toHaveLength(0);
  });

  it("returns unmapped assets separately for operator review", () => {
    const { unknownAssets, unknownExposurePct } = adaptReservoirReserves({
      ...SAMPLE_RESPONSE,
      assets: [...SAMPLE_RESPONSE.assets, { label: "Mystery Adapter", totalBalanceValue: "3" }],
      totalAssets: "103",
    });

    expect(unknownAssets).toContain("Mystery Adapter");
    expect(unknownExposurePct).toBeCloseTo((3 / 103) * 100, 6);
  });

  it("handles non-integer percentages correctly via normalizeSlices", () => {
    const { slices } = adaptReservoirReserves({
      assets: [
        { label: "USDC", totalBalanceValue: "33.33" },
        { label: "Euler - Sentora PYUSD", totalBalanceValue: "33.33" },
        { label: "Euler - Sentora RLUSD", totalBalanceValue: "33.34" },
      ],
      liabilities: [],
      totalAssets: "100",
      totalLiabilities: "0",
      equity: "0",
    });

    const total = slices.reduce((acc, s) => acc + s.pct, 0);
    expect(total).toBeCloseTo(100, 10);
    expect(slices).toHaveLength(3);
  });

  it("emits explicit unverified freshness details on fetched results", async () => {
    const result = await fetchReservoirReserves(
      { id: "r" } as never,
      {
        adapter: "reservoir",
        version: 1,
        semantics: "protocol-reserve",
        inputs: { primary: { kind: "http-json", url: "https://example.com/reservoir" } },
      },
      new AbortController().signal,
      {
        requestCache: new Map([
          ["json-get:https://example.com/reservoir:12000:{\"Origin\":\"https://app.reservoir.xyz\",\"Referer\":\"https://app.reservoir.xyz/reserves\",\"Accept-Language\":\"en-US,en;q=0.9\"}", Promise.resolve(SAMPLE_RESPONSE)],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "protocol-balance-sheet-api",
      },
      totalAssetsUsd: 100,
      totalLiabilitiesUsd: 95,
      shareholderEquityUsd: 5,
      collateralizationRatio: 100 / 95,
    });
  });

  it("aggregates unknown exposure into one warning instead of one warning per position", async () => {
    const result = await fetchReservoirReserves(
      { id: "r" } as never,
      {
        adapter: "reservoir",
        version: 1,
        semantics: "protocol-reserve",
        inputs: { primary: { kind: "http-json", url: "https://example.com/reservoir" } },
      },
      new AbortController().signal,
      {
        requestCache: new Map([
          ["json-get:https://example.com/reservoir:12000:{\"Origin\":\"https://app.reservoir.xyz\",\"Referer\":\"https://app.reservoir.xyz/reserves\",\"Accept-Language\":\"en-US,en;q=0.9\"}", Promise.resolve({
            ...SAMPLE_RESPONSE,
            assets: [
              ...SAMPLE_RESPONSE.assets,
              { label: "Mystery Adapter A", totalBalanceValue: "3" },
              { label: "Mystery Adapter B", totalBalanceValue: "2" },
            ],
            totalAssets: "105",
          })],
        ]),
      } as never,
    );

    expect(result.warnings).toEqual([expect.objectContaining({
      code: "unknown-position",
      message: expect.stringContaining("Mystery Adapter A, Mystery Adapter B"),
    })]);
    expect(result.metadata).toMatchObject({
      unknownAssetCount: 2,
      unknownAssetLabels: ["Mystery Adapter A", "Mystery Adapter B"],
      unknownExposurePct: (5 / 105) * 100,
    });
  });

  it("emits a fatal warning when total liabilities exceed total assets", async () => {
    const result = await fetchReservoirReserves(
      { id: "r" } as never,
      {
        adapter: "reservoir",
        version: 1,
        semantics: "protocol-reserve",
        inputs: { primary: { kind: "http-json", url: "https://example.com/reservoir" } },
      },
      new AbortController().signal,
      {
        requestCache: new Map([
          ["json-get:https://example.com/reservoir:12000:{\"Origin\":\"https://app.reservoir.xyz\",\"Referer\":\"https://app.reservoir.xyz/reserves\",\"Accept-Language\":\"en-US,en;q=0.9\"}", Promise.resolve({
            ...SAMPLE_RESPONSE,
            totalAssets: "100",
            totalLiabilities: "120",
            equity: "-20",
          })],
        ]),
      } as never,
    );

    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "reservoir-insolvent",
      effect: "fatal",
    })]));
  });

  it("classifies multi-stable labels via exclusive patterns", () => {
    const { slices } = adaptReservoirReserves({
      assets: [
        // PYUSD/USDC label should go to PYUSD, not USDC, because PYUSD matches first.
        { label: "Aave - PYUSD/USDC", totalBalanceValue: "50" },
        { label: "Fluid - USDT0 (Plasma)", totalBalanceValue: "25" },
        { label: "USDC", totalBalanceValue: "25" },
      ],
      liabilities: [],
      totalAssets: "100",
      totalLiabilities: "95",
      equity: "5",
    });

    const pyusdSlice = slices.find((s) => s.name === "PYUSD lending markets");
    const usdcSlice = slices.find((s) => s.name === "USDC positions");
    const usdtSlice = slices.find((s) => s.name === "USDT / USDT0 positions");
    expect(pyusdSlice?.pct).toBe(50);
    expect(usdcSlice?.pct).toBe(25);
    expect(usdtSlice?.pct).toBe(25);
  });

  it("attributes USDT0/USDC pool labels to USDT per the canonical order comment", () => {
    const { slices } = adaptReservoirReserves({
      assets: [
        // USDT0 pools commonly pair with USDC on cross-chain routes; attribute
        // them to USDT so the USDT0 wrapper is not double-counted.
        { label: "Fluid - USDT0/USDC LP", totalBalanceValue: "100" },
      ],
      liabilities: [],
      totalAssets: "100",
      totalLiabilities: "95",
      equity: "5",
    });

    const usdtSlice = slices.find((s) => s.name === "USDT / USDT0 positions");
    const usdcSlice = slices.find((s) => s.name === "USDC positions");
    expect(usdtSlice?.pct).toBe(100);
    expect(usdcSlice).toBeUndefined();
  });

  it("attributes plain USDC labels exclusively to the USDC bucket even when USD1/USDT exist", () => {
    const { slices } = adaptReservoirReserves({
      assets: [
        { label: "USDC", totalBalanceValue: "40" },
        { label: "USDT", totalBalanceValue: "30" },
        { label: "USD1", totalBalanceValue: "30" },
      ],
      liabilities: [],
      totalAssets: "100",
      totalLiabilities: "95",
      equity: "5",
    });

    const usdcSlice = slices.find((s) => s.name === "USDC positions");
    const usdtSlice = slices.find((s) => s.name === "USDT / USDT0 positions");
    const usd1Slice = slices.find((s) => s.name === "USD1 lending markets");
    expect(usdcSlice?.pct).toBe(40);
    expect(usdtSlice?.pct).toBe(30);
    expect(usd1Slice?.pct).toBe(30);
  });
});
