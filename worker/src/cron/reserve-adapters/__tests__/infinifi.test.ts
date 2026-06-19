import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import {
  adaptInfiniFi,
  fetchInfiniFiReserves,
  resolveInfiniFiFreshness,
  type InfiniFiProtocolData,
  type InfiniFiRateHistoryResponse,
} from "../infinifi";

const RATE_HISTORY_CACHE_KEY =
  "json-get:https://example.com/api/protocol/rate-history/siUSD?daysAgo=7:6000:null";

const EMPTY_RATE_HISTORY: InfiniFiRateHistoryResponse = { code: "OK", data: { dataPoints: [] } };

const SAMPLE_RESPONSE: InfiniFiProtocolData = {
  code: "OK",
  data: {
    stats: {
      asset: { totalTVLAssetNormalized: 100 },
    },
    farms: [
      {
        name: "fasanara-gdaf",
        label: "Fasanara mGLOBAL",
        assetsNormalized: 40,
        type: "ILLIQUID",
        underlyingAssetSymbol: "USDC",
      },
      {
        name: "spark-sUSDC-refcode",
        label: "Spark sUSDC",
        assetsNormalized: 30,
        type: "LIQUID",
        underlyingAssetSymbol: "sUSDC",
      },
      {
        name: "fluid-fUSDC",
        label: "Fluid USDC",
        assetsNormalized: 30,
        type: "LIQUID",
        underlyingAssetSymbol: "USDC",
      },
      {
        name: "MintController",
        label: "Mint Controller",
        assetsNormalized: 0,
        type: "PROTOCOL",
        underlyingAssetSymbol: "USDC",
      },
    ],
  },
};

describe("adaptInfiniFi", () => {
  it("allows verified freshness (rate-history probe) with unverified fallback", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS.infinifi.validation.allowedFreshnessModes).toEqual([
      "verified",
      "unverified",
    ]);
  });

  it("converts farm data to ReserveSlice[], skips PROTOCOL and zero-asset farms", () => {
    const { slices, immediateRedeemableUsd, supplyUsd } = adaptInfiniFi(SAMPLE_RESPONSE);
    expect(slices).toHaveLength(3);
    expect(slices.find((s) => s.name.includes("Fasanara"))).toMatchObject({
      pct: 40,
      risk: "high",
    });
    expect(slices.find((s) => s.name.includes("Spark"))).toMatchObject({
      pct: 30,
      risk: "low",
      coinId: "usdc-circle",
      depType: "collateral",
    });
    expect(immediateRedeemableUsd).toBe(0);
    expect(supplyUsd).toBeUndefined();
  });

  it("sums to 100 after rounding", () => {
    const total = adaptInfiniFi(SAMPLE_RESPONSE).slices.reduce((acc, s) => acc + s.pct, 0);
    expect(total).toBe(100);
  });

  it("drops farms where assetsNormalized is 0", () => {
    const { slices } = adaptInfiniFi(SAMPLE_RESPONSE);
    expect(slices.every((s) => s.pct > 0)).toBe(true);
  });

  it("returns unknown farm names in a separate list", () => {
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        farms: [
          ...SAMPLE_RESPONSE.data.farms,
          { name: "brand-new-farm", label: "Brand New", assetsNormalized: 10, type: "LIQUID", underlyingAssetSymbol: "USDC" },
        ],
        stats: { asset: { totalTVLAssetNormalized: 110 } },
      },
    };
    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toContain("brand-new-farm");
  });

  it("recognizes current tiny SwapFarm and Tokemak infiniFiUSD positions", () => {
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        farms: [
          { name: "SwapFarm", label: "Multi Farm", assetsNormalized: 1, type: "LIQUID", underlyingAssetSymbol: "USDC" },
          { name: "tokemak-auto-infinifiUSD", label: "infinifiUSD Autopool", assetsNormalized: 9, type: "ILLIQUID", underlyingAssetSymbol: "infinifiUSD" },
        ],
        stats: { asset: { totalTVLAssetNormalized: 10 } },
      },
    };

    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toEqual([]);
    expect(result.slices).toEqual([
      { name: "infinifiUSD Autopool", pct: 90, risk: "medium" },
      { name: "Multi Farm", pct: 10, risk: "low" },
    ]);
  });

  it("recognizes current Liquid Cap and CoW Swap fxSave positions", () => {
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        farms: [
          { name: "liquid-cap", label: "Liquid Cap", assetsNormalized: 60, type: "ILLIQUID", underlyingAssetSymbol: "stcUSD" },
          { name: "cowswap-fxSave", label: "CoW Swap fxSave", assetsNormalized: 40, type: "ILLIQUID", underlyingAssetSymbol: "fxUSD" },
        ],
        stats: { asset: { totalTVLAssetNormalized: 100 } },
      },
    };

    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toEqual([]);
    expect(result.slices).toEqual([
      { name: "Liquid Cap", pct: 60, risk: "medium", coinId: "stcusd-cap", depType: "collateral" },
      { name: "CoW Swap fxSave", pct: 40, risk: "medium" },
    ]);
  });

  it("recognizes current Pendle, New Silver, stcUSD, and Sentora PRIME positions", () => {
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        farms: [
          { name: "pendle-v3-PT-apxUSD-18JUN2026", label: "Pendle PT-apxUSD-18JUN2026", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "PT-apxUSD-18JUN2026" },
          { name: "pendle-v3-PT-apyUSD-18JUN2026", label: "Pendle PT-apyUSD-18JUN2026", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "PT-apyUSD-18JUN2026" },
          { name: "new-silver-junior", label: "New Silver", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "USDC" },
          { name: "morpho-v2-sentora-prime", label: "Sentora PRIME Main", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "senPYUSDPRIMEv2" },
          { name: "capfarm", label: "Cap stcUSD", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "stcUSD" },
        ],
        stats: { asset: { totalTVLAssetNormalized: 100 } },
      },
    };

    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toEqual([]);
    expect(result.unknownExposurePct).toBe(0);
    expect(result.slices).toEqual([
      { name: "Pendle PT-apxUSD-18JUN2026", pct: 20, risk: "high", coinId: "apxusd-apyx", depType: "collateral" },
      { name: "Pendle PT-apyUSD-18JUN2026", pct: 20, risk: "high", coinId: "apyusd-apyx", depType: "collateral" },
      { name: "New Silver", pct: 20, risk: "high", blacklistable: true },
      { name: "Sentora PRIME Main", pct: 20, risk: "high", coinId: "pyusd-paypal", depType: "collateral" },
      { name: "Cap stcUSD", pct: 20, risk: "medium", coinId: "stcusd-cap", depType: "collateral" },
    ]);
  });

  it("flags dust unknown farms and preserves them in final slices when they remain material at one-decimal precision", () => {
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        farms: [
          ...SAMPLE_RESPONSE.data.farms,
          { name: "dust-farm", label: "Dust Farm", assetsNormalized: 0.4, type: "LIQUID", underlyingAssetSymbol: "USDC" },
        ],
        stats: { asset: { totalTVLAssetNormalized: 100.4 } },
      },
    };

    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toContain("dust-farm");
    expect(result.slices.some((slice) => slice.name === "Dust Farm")).toBe(true);
  });

  it("propagates coinId from FARM_RISK_MAP for dependency tracking", () => {
    const response: InfiniFiProtocolData = {
      code: "OK",
      data: {
        stats: { asset: { totalTVLAssetNormalized: 100 } },
        farms: [
          { name: "morpho-v2-sentora-pyusd", label: "Sentora PYUSD", assetsNormalized: 30, type: "ILLIQUID", underlyingAssetSymbol: "PYUSD" },
          { name: "morpho-steakUSDCinfinifi", label: "Morpho steakUSDC", assetsNormalized: 25, type: "ILLIQUID", underlyingAssetSymbol: "USDC" },
          { name: "sGHO", label: "Staked GHO", assetsNormalized: 20, type: "LIQUID", underlyingAssetSymbol: "GHO" },
          { name: "maple-farm-syrup", label: "Maple Syrup USDC", assetsNormalized: 15, type: "ILLIQUID", underlyingAssetSymbol: "USDC" },
          { name: "capfarm", label: "Cap stcUSD", assetsNormalized: 5, type: "ILLIQUID", underlyingAssetSymbol: "stcUSD" },
          { name: "fasanara-gdaf", label: "Fasanara mGLOBAL", assetsNormalized: 5, type: "ILLIQUID", underlyingAssetSymbol: "USDC" },
        ],
      },
    };

    const { slices } = adaptInfiniFi(response);
    expect(slices.find((s) => s.name === "Sentora PYUSD")).toMatchObject({ coinId: "pyusd-paypal", depType: "collateral" });
    expect(slices.find((s) => s.name === "Morpho steakUSDC")).toMatchObject({ coinId: "usdc-circle", depType: "collateral" });
    expect(slices.find((s) => s.name === "Staked GHO")).toMatchObject({ coinId: "sgho-aave", depType: "collateral" });
    expect(slices.find((s) => s.name === "Maple Syrup USDC")).toMatchObject({ coinId: "usdc-circle", depType: "collateral" });
    expect(slices.find((s) => s.name === "Cap stcUSD")).toMatchObject({ coinId: "stcusd-cap", depType: "collateral" });
    // fasanara has no coinId — should be absent
    expect(slices.find((s) => s.name === "Fasanara mGLOBAL")).not.toHaveProperty("coinId");
  });

  it("preserves small farms above 0.05% before normalizeSlices rounding", () => {
    // A farm with 0.5% of TVL should pass the pct threshold and reach normalizeSlices
    const response: InfiniFiProtocolData = {
      code: "OK",
      data: {
        stats: { asset: { totalTVLAssetNormalized: 1000 } },
        farms: [
          { name: "fasanara-gdaf", label: "Fasanara mGLOBAL", assetsNormalized: 995, type: "ILLIQUID", underlyingAssetSymbol: "USDC" },
          { name: "spark-sUSDC-refcode", label: "Spark sUSDC", assetsNormalized: 5, type: "LIQUID", underlyingAssetSymbol: "sUSDC" },
        ],
      },
    };

    const { slices } = adaptInfiniFi(response);
    // Both farms should be present (0.5% passes the >=0.05 threshold)
    expect(slices).toHaveLength(2);
    expect(slices.reduce((acc, s) => acc + s.pct, 0)).toBe(100);
  });

  it("keeps PROTOCOL farm exposure explicit instead of renormalizing active farm subset", () => {
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        stats: { asset: { totalTVLAssetNormalized: 125 } },
        farms: [
          ...SAMPLE_RESPONSE.data.farms,
          {
            name: "ProtocolBuffer",
            label: "Protocol Buffer",
            assetsNormalized: 25,
            type: "PROTOCOL",
            underlyingAssetSymbol: "USDC",
          },
        ],
      },
    };

    const result = adaptInfiniFi(response);
    expect(result.excludedProtocolFarms).toEqual(["ProtocolBuffer"]);
    expect(result.sourceTotalGapPct).toBe(20);
    expect(result.slices).toEqual(expect.arrayContaining([
      { name: "InfiniFi protocol-level reserve positions", pct: 20, risk: "high" },
    ]));
  });

  it("warns when source TVL exceeds emitted active farm rows", async () => {
    const url = "https://example.com/infinifi";
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        stats: { asset: { totalTVLAssetNormalized: 125 } },
        farms: [
          ...SAMPLE_RESPONSE.data.farms,
          {
            name: "ProtocolBuffer",
            label: "Protocol Buffer",
            assetsNormalized: 25,
            type: "PROTOCOL",
            underlyingAssetSymbol: "USDC",
          },
        ],
      },
    };

    const result = await fetchInfiniFiReserves(
      { id: "infinifi" } as never,
      {
        adapter: "infinifi",
        version: 1,
        semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url } },
      },
      new AbortController().signal,
      {
        requestCache: new Map<string, Promise<unknown>>([
          [`json-get:${url}:12000:null`, Promise.resolve(response)],
          [RATE_HISTORY_CACHE_KEY, Promise.resolve(EMPTY_RATE_HISTORY)],
        ]),
      } as never,
    );

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source-total-gap", effect: "degraded" }),
    ]));
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "protocol-stats-api",
      },
      sourceTotalGapPct: 20,
      excludedProtocolFarms: ["ProtocolBuffer"],
    });
  });

  it("surfaces queue depth and route-status source from the protocol payload", async () => {
    const url = "https://example.com/infinifi";
    const response: InfiniFiProtocolData = {
      code: "OK",
      data: {
        stats: {
          asset: {
            totalTVLAssetNormalized: 100,
            totalLiquidAssetNormalized: 35,
            pendingRedemptionsAssetNormalized: 12,
          },
        },
        receipt: {
          totalSupplyNormalized: 80,
        },
        farms: [
          {
            name: "spark-sUSDC-refcode",
            label: "Spark sUSDC",
            assetsNormalized: 100,
            type: "LIQUID",
            underlyingAssetSymbol: "sUSDC",
          },
        ],
      },
    };

    const result = await fetchInfiniFiReserves(
      { id: "infinifi" } as never,
      {
        adapter: "infinifi",
        version: 1,
        semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url } },
      },
      new AbortController().signal,
      {
        requestCache: new Map<string, Promise<unknown>>([
          [`json-get:${url}:12000:null`, Promise.resolve(response)],
          [RATE_HISTORY_CACHE_KEY, Promise.resolve(EMPTY_RATE_HISTORY)],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      pendingRedemptionsUsd: 12,
      redemption: {
        capacityUsd: 35,
        capacityRatioOfSupply: 35 / 80,
        capacityKind: "live-queue",
        freshnessKind: "unverified",
        routeStatus: "unknown",
        routeStatusSource: "protocol-api",
        queueDepthUsd: 12,
        sourceUrls: [url],
      },
    });
  });

  it("falls back to unverified freshness when the optional rate-history probe has malformed data points", async () => {
    const url = "https://example.com/infinifi";
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        stats: {
          asset: { totalTVLAssetNormalized: 100 },
          staked: { exchangeRateNormalized: 1.0727 },
        },
      },
    };

    const result = await fetchInfiniFiReserves(
      { id: "infinifi" } as never,
      {
        adapter: "infinifi",
        version: 1,
        semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url } },
      },
      new AbortController().signal,
      {
        requestCache: new Map<string, Promise<unknown>>([
          [`json-get:${url}:12000:null`, Promise.resolve(response)],
          [RATE_HISTORY_CACHE_KEY, Promise.resolve({ code: "OK", data: { dataPoints: [null] } })],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessReason: "InfiniFi protocol stats payload does not expose a trustworthy source timestamp",
      },
    });
  });

  it("verifies freshness from the siUSD rate-history probe when it matches the live staked rate", async () => {
    const url = "https://example.com/infinifi";
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        stats: {
          asset: { totalTVLAssetNormalized: 100 },
          staked: { exchangeRateNormalized: 1.0727142465309754 },
        },
      },
    };
    const rateHistory: InfiniFiRateHistoryResponse = {
      code: "OK",
      data: {
        dataPoints: [
          { time: 1_781_107_200_000, value: 1.0726 },
          { time: 1_781_114_400_000, value: 1.0727 },
        ],
      },
    };

    const result = await fetchInfiniFiReserves(
      { id: "infinifi" } as never,
      {
        adapter: "infinifi",
        version: 1,
        semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url } },
      },
      new AbortController().signal,
      {
        requestCache: new Map<string, Promise<unknown>>([
          [`json-get:${url}:12000:null`, Promise.resolve(response)],
          [RATE_HISTORY_CACHE_KEY, Promise.resolve(rateHistory)],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1_781_114_400,
      redemption: {
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: 1_781_114_400,
      },
    });
  });
});

describe("resolveInfiniFiFreshness", () => {
  const payloadWithRate = (exchangeRateNormalized?: number): InfiniFiProtocolData => ({
    code: "OK",
    data: {
      stats: {
        asset: { totalTVLAssetNormalized: 100 },
        ...(exchangeRateNormalized != null ? { staked: { exchangeRateNormalized } } : {}),
      },
      farms: [],
    },
  });

  it("returns verified with the latest valid point when the rate matches within tolerance", () => {
    expect(resolveInfiniFiFreshness(payloadWithRate(1.0727142465309754), {
      code: "OK",
      data: { dataPoints: [{ time: 1_781_114_400_000, value: 1.0727 }] },
    })).toEqual({
      freshnessMode: "verified",
      sourceTimestamp: 1_781_114_400,
    });
  });

  it("stays unverified when the probe is missing, empty, or non-OK", () => {
    const expectedReason = "InfiniFi protocol stats payload does not expose a trustworthy source timestamp";
    for (const rateHistory of [null, { code: "ERROR" }, { code: "OK", data: { dataPoints: [] } }] as const) {
      expect(resolveInfiniFiFreshness(payloadWithRate(1.07), rateHistory as InfiniFiRateHistoryResponse | null))
        .toMatchObject({ freshnessMode: "unverified", details: { freshnessReason: expectedReason } });
    }
  });

  it("stays unverified for malformed rate-history dataPoints payloads", () => {
    const expectedReason = "InfiniFi protocol stats payload does not expose a trustworthy source timestamp";
    for (const rateHistory of [
      { code: "OK", data: { dataPoints: {} } },
      { code: "OK", data: { dataPoints: [null] } },
    ] as const) {
      expect(resolveInfiniFiFreshness(payloadWithRate(1.07), rateHistory))
        .toMatchObject({ freshnessMode: "unverified", details: { freshnessReason: expectedReason } });
    }
  });

  it("stays unverified when the probe diverges from the live staked rate or the rate is absent", () => {
    const diverged = "InfiniFi siUSD rate-history freshness probe diverged from the live staked exchange rate";
    const rateHistory: InfiniFiRateHistoryResponse = {
      code: "OK",
      data: { dataPoints: [{ time: 1_781_114_400_000, value: 1.08 }] },
    };
    expect(resolveInfiniFiFreshness(payloadWithRate(1.0727), rateHistory))
      .toMatchObject({ freshnessMode: "unverified", details: { freshnessReason: diverged } });
    expect(resolveInfiniFiFreshness(payloadWithRate(undefined), rateHistory))
      .toMatchObject({ freshnessMode: "unverified", details: { freshnessReason: diverged } });
  });

  it("ignores trailing malformed points and verifies from the last well-formed one", () => {
    expect(resolveInfiniFiFreshness(payloadWithRate(1.0727), {
      code: "OK",
      data: {
        dataPoints: [
          { time: 1_781_107_200_000, value: 1.0727 },
          { time: Number.NaN, value: 1.0727 },
          { value: 1.0727 },
        ],
      },
    })).toEqual({
      freshnessMode: "verified",
      sourceTimestamp: 1_781_107_200,
    });
  });
});
