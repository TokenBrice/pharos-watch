import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return { ...actual, fetchOnchainMulticall3: vi.fn() };
});

import { fetchOnchainMulticall3 } from "../helpers";
import {
  adaptInfiniFi,
  fetchInfiniFiReserves,
  resolveInfiniFiFreshness,
  type InfiniFiProtocolData,
  type InfiniFiRateHistoryResponse,
} from "../infinifi";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

const RATE_HISTORY_CACHE_KEY =
  "json-get:https://example.com/api/protocol/rate-history/siUSD?daysAgo=7:6000:null";

const EMPTY_RATE_HISTORY: InfiniFiRateHistoryResponse = { code: "OK", data: { dataPoints: [] } };

const REDEEM_CONTROLLER = "0xcb1747e89a43dedcf4a2b831a0d94859efec7601";
const YIELD_SHARING = "0x90e91f5bfd9a0a4d925bf30b512add8cd2bbae3b";
const BEFORE_REDEEM_HOOK = "0x4b2bfe49829de3632449928507452ee667f61395";
const IUSD = "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const IUSD_ONE = 10n ** 18n;
const USDC_ONE = 10n ** 6n;

interface RouteState {
  gatewayPaused: boolean;
  controllerPaused: boolean;
  yieldSharingPaused: boolean;
  hookPaused: boolean;
  unaccruedYield: bigint;
  queueLength: bigint;
  /** iUSD (18 decimals) waiting in the queue. */
  enqueued: bigint;
  fail?: boolean;
}

const OPEN_ROUTE: RouteState = {
  gatewayPaused: false,
  controllerPaused: false,
  yieldSharingPaused: false,
  hookPaused: false,
  unaccruedYield: 925n * IUSD_ONE,
  queueLength: 0n,
  enqueued: 0n,
};

function word(value: bigint | boolean | string): `0x${string}` {
  if (typeof value === "string") {
    return `0x${value.replace(/^0x/, "").toLowerCase().padStart(64, "0")}` as `0x${string}`;
  }
  const uint = typeof value === "boolean" ? (value ? 1n : 0n) : value;
  const unsigned = uint < 0n ? uint + (1n << 256n) : uint;
  return `0x${unsigned.toString(16).padStart(64, "0")}` as `0x${string}`;
}

/**
 * Answer the probe's three dependent multicall phases by label: the gateway
 * registry resolves the controller and yield-sharing addresses before either
 * can be read, and the hook address only exists after the controller batch.
 */
function primeRouteProbe(overrides: Partial<RouteState> = {}) {
  const state = { ...OPEN_ROUTE, ...overrides };
  vi.mocked(fetchOnchainMulticall3).mockImplementation((args: unknown) => {
    if (state.fail) return Promise.resolve(null);
    const { calls } = args as { calls: Array<{ label: string }> };
    return Promise.resolve(calls.map(({ label }) => {
      const returnData = ((): `0x${string}` => {
        switch (label) {
          case "gateway:paused": return word(state.gatewayPaused);
          case "gateway:redeem-controller": return word(REDEEM_CONTROLLER);
          case "gateway:yield-sharing": return word(YIELD_SHARING);
          case "gateway:receipt-token": return word(IUSD);
          case "rc:paused": return word(state.controllerPaused);
          case "rc:asset-token": return word(USDC);
          case "rc:hook": return word(BEFORE_REDEEM_HOOK);
          case "rc:queue-length": return word(state.queueLength);
          case "rc:enqueued": return word(state.enqueued);
          case "rc:pending-claims": return word(0n);
          case "rc:liquidity": return word(669n);
          // 1 iUSD converts to 1 USDC at the controller's live ratio.
          case "rc:receipt-to-asset": return word(USDC_ONE);
          case "ys:paused": return word(state.yieldSharingPaused);
          case "ys:unaccrued-yield": return word(state.unaccruedYield);
          case "hook:paused": return word(state.hookPaused);
          default: return word(0n);
        }
      })();
      return { label, success: true, returnData };
    }));
  });
}

const ROUTE_URL = "https://example.com/infinifi";

function routeResponse(overrides: {
  liquid?: number;
  supply?: number;
  pendingRedemptions?: number;
} = {}): InfiniFiProtocolData {
  return {
    code: "OK",
    data: {
      stats: {
        asset: {
          totalTVLAssetNormalized: 100,
          totalLiquidAssetNormalized: overrides.liquid ?? 35,
          ...(overrides.pendingRedemptions != null
            ? { pendingRedemptionsAssetNormalized: overrides.pendingRedemptions }
            : {}),
        },
        // The live feed nests receipt supply under stats; a payload that only
        // carried data.receipt would leave the capacity ratio unemittable.
        receipt: { totalSupplyNormalized: overrides.supply ?? 80 },
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
}

function fetchRouteReserves(response: InfiniFiProtocolData = routeResponse()) {
  return fetchInfiniFiReserves(
    { id: "infinifi" } as never,
    {
      adapter: "infinifi",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "http-json", url: ROUTE_URL } },
    },
    new AbortController().signal,
    {
      requestCache: new Map<string, Promise<unknown>>([
        [`json-get:${ROUTE_URL}:12000:null`, Promise.resolve(response)],
        [RATE_HISTORY_CACHE_KEY, Promise.resolve(EMPTY_RATE_HISTORY)],
      ]),
    } as never,
  );
}

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
  beforeEach(() => {
    vi.mocked(fetchOnchainMulticall3).mockReset();
  });

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
      coinId: "mglobal-midas-fasanara",
      depType: "collateral",
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
          { name: "cowswap-fxSave", label: "f(x) fxSAVE", assetsNormalized: 40, type: "ILLIQUID", underlyingAssetSymbol: "fxSAVE" },
        ],
        stats: { asset: { totalTVLAssetNormalized: 100 } },
      },
    };

    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toEqual([]);
    expect(result.slices).toEqual([
      { name: "Liquid Cap", pct: 60, risk: "medium", coinId: "stcusd-cap", depType: "collateral" },
      { name: "f(x) fxSAVE", pct: 40, risk: "medium", coinId: "fxsave-f-x-protocol", depType: "collateral" },
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
          { name: "fasanara-gdaf", label: "Fasanara mGLOBAL (GDADF)", assetsNormalized: 5, type: "ILLIQUID", underlyingAssetSymbol: "USDC" },
        ],
      },
    };

    const { slices } = adaptInfiniFi(response);
    expect(slices.find((s) => s.name === "Sentora PYUSD")).toMatchObject({ coinId: "pyusd-paypal", depType: "collateral" });
    expect(slices.find((s) => s.name === "Morpho steakUSDC")).toMatchObject({ coinId: "usdc-circle", depType: "collateral" });
    expect(slices.find((s) => s.name === "Staked GHO")).toMatchObject({ coinId: "sgho-aave", depType: "collateral" });
    expect(slices.find((s) => s.name === "Maple Syrup USDC")).toMatchObject({ coinId: "usdc-circle", depType: "collateral" });
    expect(slices.find((s) => s.name === "Cap stcUSD")).toMatchObject({ coinId: "stcusd-cap", depType: "collateral" });
    expect(slices.find((s) => s.name === "Fasanara mGLOBAL (GDADF)")).toMatchObject({ coinId: "mglobal-midas-fasanara", depType: "collateral" });
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

  it("reports an open route with a zero queue when every on-chain gate reads unpaused", async () => {
    primeRouteProbe();

    const result = await fetchRouteReserves(routeResponse({ pendingRedemptions: 0 }));

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      pendingRedemptionsUsd: 0,
      redemption: {
        capacityUsd: 35,
        capacityRatioOfSupply: 35 / 80,
        capacityKind: "live-queue",
        freshnessKind: "same-run-api",
        routeStatus: "open",
        routeStatusSource: "onchain",
        queueDepthUsd: 0,
        sourceUrls: [
          ROUTE_URL,
          "https://docs.infinifi.xyz/dev-docs/gateway",
          "https://docs.infinifi.xyz/dev-docs/funding/redeem-controller",
        ],
      },
      details: {
        // The route proof is additive: it must not displace the freshness detail.
        freshnessSource: "protocol-stats-api",
        redeemRoute: {
          redeemController: REDEEM_CONTROLLER,
          yieldSharing: YIELD_SHARING,
          beforeRedeemHook: BEFORE_REDEEM_HOOK,
          queueLength: 0,
          controllerLiquidityUsd: 0.000669,
        },
      },
    });
    expectValidAdapterOutput("infinifi", result);
  });

  it("degrades the route and prices the queue when redemptions are already enqueued", async () => {
    primeRouteProbe({ queueLength: 3n, enqueued: 1_250n * IUSD_ONE });

    const result = await fetchRouteReserves();

    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "degraded",
      routeStatusSource: "onchain",
      queueDepthUsd: 1_250,
      capacityUsd: 35,
    });
    expect(result.metadata?.redemption).toHaveProperty(
      "routeStatusReason",
      expect.stringContaining("queueLength() is 3"),
    );
  });

  it("reports a paused route when a gate is closed or losses are unaccrued", async () => {
    for (const closed of [
      { controllerPaused: true },
      { gatewayPaused: true },
      { hookPaused: true },
      { unaccruedYield: -1n },
    ]) {
      primeRouteProbe(closed);
      const result = await fetchRouteReserves();
      expect(result.metadata?.redemption).toMatchObject({
        routeStatus: "paused",
        routeStatusSource: "onchain",
      });
    }
  });

  it("withholds redemption telemetry when the route probe fails", async () => {
    primeRouteProbe({ fail: true });

    const result = await fetchRouteReserves();

    expect(result.metadata).not.toHaveProperty("redemption");
    expect(result.metadata?.details).not.toHaveProperty("redeemRoute");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "infinifi-redemption-route-unreadable", effect: "info" }),
    ]));
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
    primeRouteProbe();
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
