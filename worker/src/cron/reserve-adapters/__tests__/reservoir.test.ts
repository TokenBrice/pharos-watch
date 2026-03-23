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
    const { slices, immediateRedeemableUsd, supplyUsd } = adaptReservoirReserves(SAMPLE_RESPONSE);

    expect(slices).toEqual([
      { name: "USD1 lending markets", pct: 30, risk: "medium", coinId: "usd1-world-liberty-financial", depType: "wrapper" },
      { name: "PYUSD lending markets", pct: 30, risk: "medium", coinId: "pyusd-paypal", depType: "wrapper" },
      { name: "RLUSD lending markets", pct: 15, risk: "medium", coinId: "rlusd-ripple", depType: "wrapper" },
      { name: "GHO lending markets", pct: 10, risk: "medium", coinId: "gho-aave", depType: "wrapper" },
      { name: "USDT / USDT0 positions", pct: 10, risk: "medium", coinId: "usdt-tether", depType: "wrapper" },
      { name: "USDC positions", pct: 5, risk: "medium", coinId: "usdc-circle", depType: "wrapper" },
    ]);
    expect(immediateRedeemableUsd).toBe(5);
    expect(supplyUsd).toBe(95);
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
    const { unknownAssets } = adaptReservoirReserves({
      ...SAMPLE_RESPONSE,
      assets: [...SAMPLE_RESPONSE.assets, { label: "Mystery Adapter", totalBalanceValue: "3" }],
      totalAssets: "103",
    });

    expect(unknownAssets).toContain("Mystery Adapter");
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
          ["json-get:https://example.com/reservoir:12000", Promise.resolve(SAMPLE_RESPONSE)],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "protocol-balance-sheet-api",
      },
    });
  });
});
