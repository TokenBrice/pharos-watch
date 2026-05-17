import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { adaptInfiniFi, fetchInfiniFiReserves, type InfiniFiProtocolData } from "../infinifi";

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
  it("declares the timestamp-less stats API as unverified-only freshness", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS.infinifi.validation.allowedFreshnessModes).toEqual([
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
      depType: "wrapper",
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
      { name: "Liquid Cap", pct: 60, risk: "medium" },
      { name: "CoW Swap fxSave", pct: 40, risk: "medium" },
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
          { name: "fasanara-gdaf", label: "Fasanara mGLOBAL", assetsNormalized: 10, type: "ILLIQUID", underlyingAssetSymbol: "USDC" },
        ],
      },
    };

    const { slices } = adaptInfiniFi(response);
    expect(slices.find((s) => s.name === "Sentora PYUSD")).toMatchObject({ coinId: "pyusd-paypal", depType: "wrapper" });
    expect(slices.find((s) => s.name === "Morpho steakUSDC")).toMatchObject({ coinId: "usdc-circle", depType: "wrapper" });
    expect(slices.find((s) => s.name === "Staked GHO")).toMatchObject({ coinId: "gho-aave", depType: "wrapper" });
    expect(slices.find((s) => s.name === "Maple Syrup USDC")).toMatchObject({ coinId: "usdc-circle", depType: "wrapper" });
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
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve(response)],
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
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve(response)],
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
});
