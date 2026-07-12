import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { adaptReservoirReserves, fetchReservoirReserves, type ReservoirReservesResponse } from "../reservoir";
import { buildBrowserHeaders, NEUTRAL_ADAPTER_HEADERS } from "../request";

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
const RESERVOIR_TEST_URL = "https://example.com/reservoir";
const RESERVOIR_BROWSER_CACHE_KEY = `json-get:${RESERVOIR_TEST_URL}:20000:${JSON.stringify(
  buildBrowserHeaders("https://app.reservoir.xyz", "https://app.reservoir.xyz/reserves"),
)}`;
const RESERVOIR_NEUTRAL_CACHE_KEY = `json-get:${RESERVOIR_TEST_URL}:20000:${JSON.stringify(NEUTRAL_ADAPTER_HEADERS)}`;

describe("adaptReservoirReserves", () => {
  it("declares the timestamp-less balance-sheet API as unverified freshness", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS.reservoir.validation.allowedFreshnessModes).toContain("unverified");
  });

  it("groups live balance-sheet assets into reserve slices", () => {
    const { slices, immediateRedeemableUsd, supplyUsd, unknownExposurePct } = adaptReservoirReserves(SAMPLE_RESPONSE);

    expect(slices).toEqual([
      {
        name: "USD1 lending markets",
        pct: 30,
        risk: "medium",
        coinId: "usd1-world-liberty-financial",
        depType: "collateral",
      },
      { name: "PYUSD lending markets", pct: 30, risk: "medium", coinId: "pyusd-paypal", depType: "collateral" },
      { name: "RLUSD lending markets", pct: 15, risk: "medium", coinId: "rlusd-ripple", depType: "collateral" },
      { name: "GHO lending markets", pct: 10, risk: "medium", coinId: "gho-aave", depType: "collateral" },
      { name: "USDT / USDT0 positions", pct: 10, risk: "medium", coinId: "usdt-tether", depType: "collateral" },
      { name: "USDC positions", pct: 5, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
    ]);
    // All stable buckets count toward immediate redemption capacity, not just USDC.
    expect(immediateRedeemableUsd).toBe(95);
    expect(supplyUsd).toBe(95);
    expect(unknownExposurePct).toBe(0);
  });

  it("classifies current Reservoir AUSD and Steakhouse Prime strategy rows", () => {
    const { slices, unknownExposurePct, immediateRedeemableUsd } = adaptReservoirReserves({
      assets: [
        {
          label: "Morpho - Grove x Steakhouse High Yield AUSD",
          description: "The Steakhouse High Yield AUSD vault lends AUSD against approved collateral.",
          iconPath: "/ausd.svg",
          totalBalanceValue: "60",
        },
        {
          label: "Morpho - Steakhouse Prime Instant V2 Adapter",
          description: "Steakhouse Prime Instant vault aims to optimize yields by lending USDC.",
          iconPath: "/USDC.svg",
          totalBalanceValue: "40",
        },
      ],
      liabilities: [],
      totalAssets: "100",
      totalLiabilities: "95",
      equity: "5",
    });

    expect(slices).toEqual([
      { name: "AUSD lending markets", pct: 60, risk: "medium", coinId: "ausd-agora", depType: "collateral" },
      { name: "USDC positions", pct: 40, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
    ]);
    expect(immediateRedeemableUsd).toBe(95);
    expect(unknownExposurePct).toBe(0);
  });

  it("classifies reviewed Reservoir PRIME and PT USDat rows as high-risk buckets", () => {
    const { slices, unknownExposurePct } = adaptReservoirReserves({
      assets: [
        {
          label: "Hastra - PRIME",
          description: "Staked PRIME backed by real-world HELOC lending.",
          totalBalanceValue: "35",
        },
        {
          label: "Morpho - Sentora PRIME",
          description: "Sentora PRIME Main lending against PRIME",
          totalBalanceValue: "40",
        },
        {
          label: "Pendle - PT USDat",
          description: "Pendle principal token for USDat expiring on August 27 2026",
          totalBalanceValue: "25",
        },
      ],
      liabilities: [],
      totalAssets: "100",
      totalLiabilities: "95",
      equity: "5",
    });

    expect(slices).toEqual([
      { name: "Hastra / Sentora PRIME credit allocations", pct: 75, risk: "high" },
      {
        name: "Pendle PT USDat tokenized-treasury principal token",
        pct: 25,
        risk: "high",
        coinId: "usdat-saturn",
        depType: "collateral",
      },
    ]);
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

  it("does not classify assets from non-authoritative description or icon metadata", () => {
    const { slices, unknownAssets, unknownExposurePct, immediateRedeemableUsd } = adaptReservoirReserves({
      assets: [
        {
          label: "Mystery Strategy Vault",
          description: "opaque strategy; not USDC backed; not an AUSD market",
          iconPath: "/icons/not-USDC-or-AUSD.svg",
          totalBalanceValue: "100",
        },
      ],
      liabilities: [],
      totalAssets: "100",
      totalLiabilities: "95",
      equity: "5",
    });

    expect(slices).toEqual([{ name: "Unmapped reserve positions", pct: 100, risk: "high" }]);
    expect(unknownAssets).toEqual(["Mystery Strategy Vault"]);
    expect(unknownExposurePct).toBe(100);
    expect(immediateRedeemableUsd).toBe(0);
  });

  it("keeps source total-assets gaps explicit instead of renormalizing disclosed rows", () => {
    const { slices, unknownAssets, sourceTotalGapPct } = adaptReservoirReserves({
      ...SAMPLE_RESPONSE,
      totalAssets: "125",
    });

    expect(unknownAssets).toContain("Unmapped Reservoir balance-sheet total-assets gap");
    expect(sourceTotalGapPct).toBe(20);
    expect(slices).toEqual(expect.arrayContaining([{ name: "Unmapped reserve positions", pct: 20, risk: "high" }]));
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

  it("emits unverified freshness for timestamp-less protocol API telemetry", async () => {
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
          [
            'json-get:https://example.com/reservoir:20000:{"Origin":"https://app.reservoir.xyz","Referer":"https://app.reservoir.xyz/reserves","Accept-Language":"en-US,en;q=0.9"}',
            Promise.resolve(SAMPLE_RESPONSE),
          ],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "protocol-balance-sheet-api",
        freshnessReason: expect.stringContaining("not independently freshness-verified"),
      },
      totalAssetsUsd: 100,
      totalLiabilitiesUsd: 95,
      shareholderEquityUsd: 5,
      collateralizationRatio: 100 / 95,
      redemption: { routeStatus: "unknown", routeStatusSource: "protocol-api" },
    });
    // No timestamped disclosure exists; the adapter must not invent score-grade freshness.
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      freshnessKind: "unverified",
    });
  });

  it("falls back to neutral API headers when browser-style headers fail", async () => {
    const result = await fetchReservoirReserves(
      { id: "r" } as never,
      {
        adapter: "reservoir",
        version: 1,
        semantics: "protocol-reserve",
        inputs: { primary: { kind: "http-json", url: RESERVOIR_TEST_URL } },
      },
      new AbortController().signal,
      {
        requestCache: new Map([
          [RESERVOIR_BROWSER_CACHE_KEY, Promise.reject(new Error("browser headers rejected"))],
          [RESERVOIR_NEUTRAL_CACHE_KEY, Promise.resolve(SAMPLE_RESPONSE)],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      totalAssetsUsd: 100,
      totalLiabilitiesUsd: 95,
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
          [
            'json-get:https://example.com/reservoir:20000:{"Origin":"https://app.reservoir.xyz","Referer":"https://app.reservoir.xyz/reserves","Accept-Language":"en-US,en;q=0.9"}',
            Promise.resolve({
              ...SAMPLE_RESPONSE,
              assets: [
                ...SAMPLE_RESPONSE.assets,
                { label: "Mystery Adapter A", totalBalanceValue: "3" },
                { label: "Mystery Adapter B", totalBalanceValue: "2" },
              ],
              totalAssets: "105",
            }),
          ],
        ]),
      } as never,
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "unknown-position",
        message: expect.stringContaining("Mystery Adapter A, Mystery Adapter B"),
      }),
    ]);
    expect(result.metadata).toMatchObject({
      unknownAssetCount: 2,
      unknownAssetLabels: ["Mystery Adapter A", "Mystery Adapter B"],
      unknownExposurePct: (5 / 105) * 100,
    });
  });

  it("emits a degraded warning when totalAssets exceeds disclosed asset rows", async () => {
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
          [
            'json-get:https://example.com/reservoir:20000:{"Origin":"https://app.reservoir.xyz","Referer":"https://app.reservoir.xyz/reserves","Accept-Language":"en-US,en;q=0.9"}',
            Promise.resolve({
              ...SAMPLE_RESPONSE,
              totalAssets: "125",
            }),
          ],
        ]),
      } as never,
    );

    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "source-total-gap", effect: "degraded" })]),
    );
    expect(result.metadata).toMatchObject({
      sourceTotalGapPct: 20,
    });
  });

  it("emits a degraded warning when total liabilities exceed total assets", async () => {
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
          [
            'json-get:https://example.com/reservoir:20000:{"Origin":"https://app.reservoir.xyz","Referer":"https://app.reservoir.xyz/reserves","Accept-Language":"en-US,en;q=0.9"}',
            Promise.resolve({
              ...SAMPLE_RESPONSE,
              totalAssets: "100",
              totalLiabilities: "120",
              equity: "-20",
            }),
          ],
        ]),
      } as never,
    );

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "reservoir-insolvent",
          effect: "degraded",
        }),
      ]),
    );
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
