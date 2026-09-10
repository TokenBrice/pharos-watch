import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { encodeUint256, PAUSED_SELECTOR } from "../../../lib/evm-selectors";
import {
  adaptInfiniFi,
  resolveInfiniFiFreshness,
  type InfiniFiProtocolData,
  type InfiniFiRateHistoryResponse,
} from "../infinifi";
import { runAdapter, type AdapterNetworkSpec, type AdapterRpcValue } from "./reserve-adapter.test-support";

// The real catalog endpoint for iusd-infinifi; runAdapter resolves it from the
// coin's liveReservesConfig, and the freshness probe path hangs off the same origin.
const ROUTE_URL = "https://eth-api.infinifi.xyz/api/protocol/data";
const RATE_HISTORY_URL = "https://eth-api.infinifi.xyz/api/protocol/rate-history/siUSD?daysAgo=7";

const EMPTY_RATE_HISTORY: InfiniFiRateHistoryResponse = { code: "OK", data: { dataPoints: [] } };

// Gateway registry answers the probe re-reads same-run; the gateway itself is
// the adapter's tracked deployment.
const GATEWAY = "0x3f04b65ddbd87f9ce0a2e7eb24d80e7fb87625b5";
const REDEEM_CONTROLLER = "0xcb1747e89a43dedcf4a2b831a0d94859efec7601";
const YIELD_SHARING = "0x90e91f5bfd9a0a4d925bf30b512add8cd2bbae3b";
const BEFORE_REDEEM_HOOK = "0x4b2bfe49829de3632449928507452ee667f61395";
const IUSD = "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const IUSD_ONE = 10n ** 18n;
const USDC_ONE = 10n ** 6n;

// View selectors the route probe reads; `paused()` is shared by every gate.
const ASSET_TOKEN_SELECTOR = "0x1083f761"; // assetToken()
const BEFORE_REDEEM_HOOK_SELECTOR = "0xce25b2c6"; // beforeRedeemHook()
const QUEUE_LENGTH_SELECTOR = "0xab91c7b0"; // queueLength()
const TOTAL_ENQUEUED_REDEMPTIONS_SELECTOR = "0x3f3b03ca"; // totalEnqueuedRedemptions()
const TOTAL_PENDING_CLAIMS_SELECTOR = "0x70bf2381"; // totalPendingClaims()
const LIQUIDITY_SELECTOR = "0x1a686502"; // liquidity()
const RECEIPT_TO_ASSET_CALLDATA = `0xf308cf65${encodeUint256(IUSD_ONE)}`; // receiptToAsset(1 iUSD)
const UNACCRUED_YIELD_SELECTOR = "0xf843336c"; // unaccruedYield()

// The gateway's string-keyed registry reads share one selector, so the rpc
// table keys them by full calldata.
const GATEWAY_REDEEM_CONTROLLER_CALLDATA =
  "0xbf40fac10000000000000000000000000000000000000000000000000000000000000020"
  + "000000000000000000000000000000000000000000000000000000000000001072656465656d436f6e74726f6c6c657200000000000000000000000000000000";
const GATEWAY_YIELD_SHARING_CALLDATA =
  "0xbf40fac10000000000000000000000000000000000000000000000000000000000000020"
  + "000000000000000000000000000000000000000000000000000000000000000c7969656c6453686172696e670000000000000000000000000000000000000000";
const GATEWAY_RECEIPT_TOKEN_CALLDATA =
  "0xbf40fac10000000000000000000000000000000000000000000000000000000000000020"
  + "000000000000000000000000000000000000000000000000000000000000000c72656365697074546f6b656e0000000000000000000000000000000000000000";

// The rate-history fixture's latest point; the validation clock hangs off it
// so a verified run sees a fresh source timestamp.
const RATE_HISTORY_SOURCE_SEC = 1_781_114_400;
const NOW_SEC = RATE_HISTORY_SOURCE_SEC + 600;

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

/**
 * Answer the probe's three dependent multicall phases at the fetch boundary:
 * the gateway registry resolves the controller and yield-sharing addresses
 * before either can be read, and the hook address only exists after the
 * controller batch. Keys are the wire-level contract+calldata pairs the
 * Multicall3 batch decodes to.
 */
function routeRpcTable(state: RouteState): Record<string, AdapterRpcValue> {
  const table: Record<string, AdapterRpcValue> = {
    [`ethereum:${GATEWAY}:${PAUSED_SELECTOR}`]: state.gatewayPaused,
    [`ethereum:${GATEWAY}:${GATEWAY_REDEEM_CONTROLLER_CALLDATA}`]: REDEEM_CONTROLLER,
    [`ethereum:${GATEWAY}:${GATEWAY_YIELD_SHARING_CALLDATA}`]: YIELD_SHARING,
    [`ethereum:${GATEWAY}:${GATEWAY_RECEIPT_TOKEN_CALLDATA}`]: IUSD,
    [`ethereum:${REDEEM_CONTROLLER}:${PAUSED_SELECTOR}`]: state.controllerPaused,
    [`ethereum:${REDEEM_CONTROLLER}:${ASSET_TOKEN_SELECTOR}`]: USDC,
    [`ethereum:${REDEEM_CONTROLLER}:${BEFORE_REDEEM_HOOK_SELECTOR}`]: BEFORE_REDEEM_HOOK,
    [`ethereum:${REDEEM_CONTROLLER}:${QUEUE_LENGTH_SELECTOR}`]: state.queueLength,
    [`ethereum:${REDEEM_CONTROLLER}:${TOTAL_ENQUEUED_REDEMPTIONS_SELECTOR}`]: state.enqueued,
    [`ethereum:${REDEEM_CONTROLLER}:${TOTAL_PENDING_CLAIMS_SELECTOR}`]: 0n,
    [`ethereum:${REDEEM_CONTROLLER}:${LIQUIDITY_SELECTOR}`]: 669n,
    [`ethereum:${REDEEM_CONTROLLER}:${RECEIPT_TO_ASSET_CALLDATA}`]: USDC_ONE,
    [`ethereum:${YIELD_SHARING}:${PAUSED_SELECTOR}`]: state.yieldSharingPaused,
    [`ethereum:${YIELD_SHARING}:${UNACCRUED_YIELD_SELECTOR}`]: state.unaccruedYield,
    [`ethereum:${BEFORE_REDEEM_HOOK}:${PAUSED_SELECTOR}`]: state.hookPaused,
  };
  // A failed probe reverts every route read; the adapter must withhold
  // redemption telemetry rather than publish a partial route.
  if (state.fail) {
    return Object.fromEntries(Object.keys(table).map((key) => [key, null] as const));
  }
  return table;
}

function infinifiNetwork(options: {
  routeState?: Partial<RouteState>;
  payload?: InfiniFiProtocolData;
  rateHistory?: InfiniFiRateHistoryResponse;
} = {}): AdapterNetworkSpec {
  return {
    json: {
      [ROUTE_URL]: options.payload ?? routeResponse(),
      [RATE_HISTORY_URL]: options.rateHistory ?? EMPTY_RATE_HISTORY,
    },
    rpc: routeRpcTable({ ...OPEN_ROUTE, ...options.routeState }),
  };
}

function run(network: AdapterNetworkSpec = infinifiNetwork()) {
  return runAdapter("infinifi", "iusd-infinifi", { network, nowSec: NOW_SEC });
}

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

function farmResponse(farms: InfiniFiProtocolData["data"]["farms"], totalTVLAssetNormalized: number): InfiniFiProtocolData {
  return { code: "OK", data: { stats: { asset: { totalTVLAssetNormalized } }, farms } };
}

function protocolBufferResponse() {
  return farmResponse([
    ...SAMPLE_RESPONSE.data.farms,
    { name: "ProtocolBuffer", label: "Protocol Buffer", assetsNormalized: 25, type: "PROTOCOL", underlyingAssetSymbol: "USDC" },
  ], 125);
}

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
    const response = farmResponse([
      { name: "SwapFarm", label: "Multi Farm", assetsNormalized: 1, type: "LIQUID", underlyingAssetSymbol: "USDC" },
      { name: "tokemak-auto-infinifiUSD", label: "infinifiUSD Autopool", assetsNormalized: 9, type: "ILLIQUID", underlyingAssetSymbol: "infinifiUSD" },
    ], 10);

    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toEqual([]);
    expect(result.slices).toEqual([
      { sourceKey: "infinifi:tokemak-auto-infinifiusd", name: "infinifiUSD Autopool", pct: 90, risk: "medium" },
      { sourceKey: "infinifi:swapfarm", name: "Multi Farm", pct: 10, risk: "low" },
    ]);
  });

  it("recognizes current Liquid Cap and CoW Swap fxSave positions", () => {
    const response = farmResponse([
      { name: "liquid-cap", label: "Liquid Cap", assetsNormalized: 60, type: "ILLIQUID", underlyingAssetSymbol: "stcUSD" },
      { name: "cowswap-fxSave", label: "f(x) fxSAVE", assetsNormalized: 40, type: "ILLIQUID", underlyingAssetSymbol: "fxSAVE" },
    ], 100);

    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toEqual([]);
    expect(result.slices).toEqual([
      { sourceKey: "infinifi:liquid-cap", name: "Liquid Cap", pct: 60, risk: "medium", coinId: "stcusd-cap", depType: "collateral" },
      { sourceKey: "infinifi:cowswap-fxsave", name: "f(x) fxSAVE", pct: 40, risk: "medium", coinId: "fxsave-f-x-protocol", depType: "collateral" },
    ]);
  });

  it("recognizes current Pendle, New Silver, stcUSD, and Sentora PRIME positions", () => {
    const response = farmResponse([
      { name: "pendle-v3-PT-apxUSD-18JUN2026", label: "Pendle PT-apxUSD-18JUN2026", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "PT-apxUSD-18JUN2026" },
      { name: "pendle-v3-PT-apyUSD-18JUN2026", label: "Pendle PT-apyUSD-18JUN2026", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "PT-apyUSD-18JUN2026" },
      { name: "new-silver-junior", label: "New Silver", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "USDC" },
      { name: "morpho-v2-sentora-prime", label: "Sentora PRIME Main", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "senPYUSDPRIMEv2" },
      { name: "capfarm", label: "Cap stcUSD", assetsNormalized: 20, type: "ILLIQUID", underlyingAssetSymbol: "stcUSD" },
    ], 100);

    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toEqual([]);
    expect(result.unknownExposurePct).toBe(0);
    expect(result.slices).toEqual([
      { sourceKey: "infinifi:pendle-v3-pt-apxusd-18jun2026", name: "Pendle PT-apxUSD-18JUN2026", pct: 20, risk: "high", coinId: "apxusd-apyx", depType: "collateral" },
      { sourceKey: "infinifi:pendle-v3-pt-apyusd-18jun2026", name: "Pendle PT-apyUSD-18JUN2026", pct: 20, risk: "high", coinId: "apyusd-apyx", depType: "collateral" },
      { sourceKey: "infinifi:new-silver-junior", name: "New Silver", pct: 20, risk: "high", blacklistable: true },
      { sourceKey: "infinifi:morpho-v2-sentora-prime", name: "Sentora PRIME Main", pct: 20, risk: "high", coinId: "pyusd-paypal", depType: "collateral" },
      { sourceKey: "infinifi:capfarm", name: "Cap stcUSD", pct: 20, risk: "medium", coinId: "stcusd-cap", depType: "collateral" },
    ]);
  });

  it("flags dust unknown farms and preserves them in final slices when they remain material at one-decimal precision", () => {
    const response = farmResponse([
      ...SAMPLE_RESPONSE.data.farms,
      { name: "dust-farm", label: "Dust Farm", assetsNormalized: 0.4, type: "LIQUID", underlyingAssetSymbol: "USDC" },
    ], 100.4);

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
    const response = protocolBufferResponse();

    const result = adaptInfiniFi(response);
    expect(result.excludedProtocolFarms).toEqual(["ProtocolBuffer"]);
    expect(result.sourceTotalGapPct).toBe(20);
    expect(result.slices).toEqual(expect.arrayContaining([
      { sourceKey: "infinifi:tvl-gap", name: "InfiniFi protocol-level reserve positions", pct: 20, risk: "high" },
    ]));
  });

});

describe("fetchInfiniFiReserves", () => {
  it("warns when source TVL exceeds emitted active farm rows", async () => {
    const { result } = await run(infinifiNetwork({ payload: protocolBufferResponse() }));

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
    const { result } = await run(infinifiNetwork({ payload: routeResponse({ pendingRedemptions: 0 }) }));

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
  });

  it("degrades the route and prices the queue when redemptions are already enqueued", async () => {
    const { result } = await run(infinifiNetwork({
      routeState: { queueLength: 3n, enqueued: 1_250n * IUSD_ONE },
    }));

    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "degraded",
      routeStatusSource: "onchain",
      queueDepthUsd: 1_250,
      capacityUsd: 35,
    });
  });

  it("reports a paused route when a gate is closed or losses are unaccrued", async () => {
    for (const closed of [
      { controllerPaused: true },
      { gatewayPaused: true },
      { hookPaused: true },
      { unaccruedYield: -1n },
    ]) {
      const { result } = await run(infinifiNetwork({ routeState: closed }));
      expect(result.metadata?.redemption).toMatchObject({
        routeStatus: "paused",
        routeStatusSource: "onchain",
      });
    }
  });

  it("fails closed when the upstream payload drops the farm rows", async () => {
    const payload = routeResponse();
    const drifted = { ...payload, data: { ...payload.data, farms: undefined } } as unknown as InfiniFiProtocolData;
    await expect(run(infinifiNetwork({ payload: drifted }))).rejects.toThrow();
  });

  it("withholds redemption telemetry when the route probe fails", async () => {
    const { result } = await run(infinifiNetwork({ routeState: { fail: true } }));

    expect(result.metadata).not.toHaveProperty("redemption");
    expect(result.metadata?.details).not.toHaveProperty("redeemRoute");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "infinifi-redemption-route-unreadable", effect: "info" }),
    ]));
  });

  it("falls back to unverified freshness when the optional rate-history probe has malformed data points", async () => {
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

    const { result } = await run(infinifiNetwork({
      payload: response,
      rateHistory: { code: "OK", data: { dataPoints: [null] } },
    }));

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
    });
  });

  it("verifies freshness from the siUSD rate-history probe when it matches the live staked rate", async () => {
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
          { time: RATE_HISTORY_SOURCE_SEC * 1_000, value: 1.0727 },
        ],
      },
    };

    const { result } = await run(infinifiNetwork({ payload: response, rateHistory }));

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: RATE_HISTORY_SOURCE_SEC,
      redemption: {
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: RATE_HISTORY_SOURCE_SEC,
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

  it("stays unverified for drift beyond the tightened 6e-5 rounding envelope", () => {
    // Δ = 7e-5 is past the 4-decimal rounding envelope but was admitted by the
    // old 5e-4 tolerance (~2.45 days of yield drift); it must now fail closed.
    const diverged = "InfiniFi siUSD rate-history freshness probe diverged from the live staked exchange rate";
    expect(resolveInfiniFiFreshness(payloadWithRate(1.07277), {
      code: "OK",
      data: { dataPoints: [{ time: 1_781_114_400_000, value: 1.0727 }] },
    })).toMatchObject({ freshnessMode: "unverified", details: { freshnessReason: diverged } });
    // Δ = 5e-5 (one rounding step) is still admitted.
    expect(resolveInfiniFiFreshness(payloadWithRate(1.07275), {
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
