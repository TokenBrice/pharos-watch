import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector } from "viem/utils";
import {
  runAdapter,
  installAdapterNetwork,
  expectWarningEffect,
  type AdapterNetworkSpec,
  type AdapterRpcCall,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";

import { adaptCrvUsd, adaptCrvUsdOnchain } from "../crvusd";

type TestHexAddress = `0x${string}`;

const BTC_ASSET = "0x00000000000000000000000000000000000000b0";
const BTC_LT = "0x00000000000000000000000000000000000000b1";
const ETH_ASSET = "0x00000000000000000000000000000000000000e0";
const ETH_LT = "0x00000000000000000000000000000000000000e1";
const LLAMMA_AMM = "0x00000000000000000000000000000000000000a1";
const LLAMMA_CONTROLLER = "0x00000000000000000000000000000000000000a2";
const CURVE_CONTROLLER_FACTORY = "0xC9332fdCB1C491Dcc683bAe86Fe3cb70360738BC";
const YIELD_BASIS_FACTORY = "0x370a449febb9411c95bf897021377fe0b7d100c0";
const CURVE_FACTORY_ABI = parseAbi([
  "function n_collaterals() view returns (uint256)",
  "function collaterals(uint256) view returns (address)",
  "function controllers(uint256) view returns (address)",
  "function amms(uint256) view returns (address)",
]);
const YIELD_BASIS_FACTORY_ABI = parseAbi([
  "function market_count() view returns (uint256)",
  "function markets(uint256) view returns (address asset_token, address cryptopool, address amm, address lt, address price_oracle, address virtual_pool, address staker)",
]);
const YIELD_BASIS_LT_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function preview_emergency_withdraw(uint256 shares) view returns (uint256,int256)",
]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

const BANDS_Y_SELECTOR = toFunctionSelector("bands_y(int256)");
const BANDS_X_SELECTOR = toFunctionSelector("bands_x(int256)");

describe("adaptCrvUsd", () => {
  it("groups official Curve market data into Pharos reserve buckets", () => {
    const result = adaptCrvUsd({
      chains: {
        ethereum: {
          data: [
            { collateral_amount_usd: 700, collateral_token: { symbol: "WBTC" } },
            { collateral_amount_usd: 100, collateral_token: { symbol: "tBTC" } },
            { collateral_amount_usd: 120, collateral_token: { symbol: "weETH" } },
            { collateral_amount_usd: 80, collateral_token: { symbol: "WETH" } },
          ],
        },
      },
    });

    expect(result.slices).toEqual([
      { sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 70, risk: "medium" },
      { sourceKey: "crvusd:eth-lst",
      name: "wstETH / sfrxETH / weETH", pct: 12, risk: "low" },
      { sourceKey: "crvusd:tbtc",
      name: "tBTC", pct: 10, risk: "medium" },
      { sourceKey: "crvusd:eth",
      name: "ETH", pct: 8, risk: "very-low" },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.metadata).toMatchObject({
      marketCount: 4,
      activeMarketCount: 4,
      bucketCount: 4,
      freshnessMode: "unverified",
      details: {
        freshnessSource: "curve-market-api + yield-basis-onchain",
      },
    });
  });

  it("folds Yield Basis collateral into the same reserve buckets", () => {
    const result = adaptCrvUsd(
      {
        chains: {
          ethereum: {
            data: [
              { collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } },
              { collateral_amount_usd: 50, collateral_token: { symbol: "WETH" } },
            ],
          },
        },
      },
      [
        { marketId: 3, symbol: "WBTC", usd: 200 },
        { marketId: 6, symbol: "WETH", usd: 100 },
      ],
    );

    expect(result.slices).toEqual([
      { sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 66.7, risk: "medium" },
      { sourceKey: "crvusd:eth",
      name: "ETH", pct: 33.3, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      marketCount: 4,
      directMarketCount: 2,
      yieldBasisMarketCount: 2,
      directCollateralUsd: 150,
      yieldBasisCollateralUsd: 300,
      yieldBasisCollateralPct: 66.66666666666666,
    });
  });
  it("retains unknown collateral in the denominator and exposes its exact share", () => {
    const result = adaptCrvUsd({ chains: { ethereum: { data: [
      { collateral_amount_usd: 75, collateral_token: { symbol: "WBTC" } },
      { collateral_amount_usd: 25, collateral_token: { symbol: "UNREVIEWED" } },
    ] } } });
    expect(result.slices).toEqual([
      { sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 75, risk: "medium" },
      { sourceKey: "crvusd:unknown",
      name: "Other / unmapped collateral markets", pct: 25, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({ unknownExposurePct: 25, activeMarketCount: 2, directCollateralUsd: 100 });
    expect(result.warnings).toEqual([expect.objectContaining({ code: "unknown-market" })]);
  });

  it("publishes all-unknown positive exposure rather than an empty recognized basket", () => {
    const result = adaptCrvUsd({ chains: { ethereum: { data: [
      { collateral_amount_usd: 100, collateral_token: { symbol: "UNREVIEWED" } },
    ] } } });
    expect(result.slices).toEqual([{ sourceKey: "crvusd:unknown",
      name: "Other / unmapped collateral markets", pct: 100, risk: "high" }]);
    expect(result.metadata).toMatchObject({ unknownExposurePct: 100, activeMarketCount: 1 });
    expect(result.warnings).toEqual([expect.objectContaining({ code: "unknown-market" })]);
  });

  it("excludes nonpositive and nonfinite values from exposure and active counts", () => {
    const result = adaptCrvUsd({ chains: { ethereum: { data: [
      { collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } },
      ...[0, -10, NaN, Infinity].map((collateral_amount_usd) => ({
        collateral_amount_usd, collateral_token: { symbol: "UNREVIEWED" },
      })),
    ] } } }, [
      { marketId: 1, symbol: "WETH", usd: 100 },
      { marketId: 2, symbol: "UNREVIEWED", usd: -50 },
      { marketId: 3, symbol: "UNREVIEWED", usd: Infinity },
    ]);
    expect(result.slices).toEqual([
      { sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 50, risk: "medium" },
      { sourceKey: "crvusd:eth",
      name: "ETH", pct: 50, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      unknownExposurePct: 0, activeMarketCount: 2, directActiveMarketCount: 1,
      yieldBasisActiveMarketCount: 1, directCollateralUsd: 100, yieldBasisCollateralUsd: 100,
    });
    expect(result.warnings).toEqual([]);
  });


  it("uses not-applicable freshness for direct LLAMMA onchain exposures", () => {
    const result = adaptCrvUsdOnchain(
      [
        {
          marketId: 0,
          symbol: "WBTC",
          collateralAddress: BTC_ASSET,
          ammAddress: LLAMMA_AMM,
          collateralUsd: 100,
          softLiquidatedCrvUsdUsd: 2,
          minBand: 0,
          maxBand: 1,
          bandCount: 2,
        },
      ],
      [{ marketId: 1, symbol: "WETH", usd: 50 }],
    );

    expect(result.slices).toEqual([
      { sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 66.7, risk: "medium" },
      { sourceKey: "crvusd:eth",
      name: "ETH", pct: 33.3, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      directCollateralUsd: 100,
      yieldBasisCollateralUsd: 50,
      softLiquidatedCrvUsdUsd: 2,
      bandReadCount: 2,
      details: {
        proofKind: "curve-llamma-direct-onchain",
      },
    });
  });

  it("does not infer redemption telemetry from LLAMMA inventory alone", () => {
    const result = adaptCrvUsdOnchain(
      [
        {
          marketId: 0,
          symbol: "WBTC",
          collateralAddress: BTC_ASSET,
          ammAddress: LLAMMA_AMM,
          collateralUsd: 100,
          softLiquidatedCrvUsdUsd: 25,
          minBand: 0,
          maxBand: 1,
          bandCount: 2,
        },
      ],
      [],
    );

    expect(result.metadata).toMatchObject({
      softLiquidatedCrvUsdUsd: 25,
      bandReadCount: 2,
    });
    expect(result.metadata?.redemption).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fetch-level scenarios against the harness network boundary.
// ---------------------------------------------------------------------------

const CRVUSD_COIN_ID = "crvusd-curve";
const CURVE_MARKETS_URL = "https://prices.curve.finance/v1/crvusd/markets";
const NOW_SEC = 1_800_000_000;
const DEFAULT_COLLATERAL_PRICES: Record<string, number> = {
  [BTC_ASSET.toLowerCase()]: 100,
  [ETH_ASSET.toLowerCase()]: 10,
};
const HTTP_CRVUSD_INPUTS = {
  inputs: { primary: { kind: "http-json", url: CURVE_MARKETS_URL } },
} as never;

function priceKey(address: string): string {
  return `ethereum:${address.toLowerCase()}`;
}

function priceUrl(keys: readonly string[]): string {
  return `https://coins.llama.fi/prices/current/${[...new Set(keys)].sort().join(",")}`;
}

function symbolResult(symbol: string): string {
  return encodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", result: symbol });
}

function yieldBasisMarketFor(marketId: number): {
  assetAddress: TestHexAddress;
  ltAddress: TestHexAddress;
} {
  return marketId === 0
    ? { assetAddress: BTC_ASSET, ltAddress: BTC_LT }
    : { assetAddress: ETH_ASSET, ltAddress: ETH_LT };
}

interface LlammaScenario {
  marketCount?: number;
  collateralByIndex?: Readonly<Record<number, TestHexAddress>>;
  bandRange?: { min?: number; max?: number };
  bandY?: bigint;
  bandX?: bigint;
}

interface YieldBasisScenario {
  marketCount?: number;
  /** Answer market_count() with a failed call. */
  failMarketCount?: boolean;
  tokenDecimals?: (assetAddress: string) => number;
}

interface CrvUsdScenario {
  llamma?: LlammaScenario;
  yieldBasis?: YieldBasisScenario;
  /** When present the run uses the HTTP Curve markets input with this payload. */
  curvePayload?: unknown;
}

function crvUsdNetwork(scenario: CrvUsdScenario): AdapterNetworkSpec {
  const llamma = scenario.llamma;
  const yb = scenario.yieldBasis;
  const marketCount = llamma?.marketCount ?? 0;
  const collateralFor = (marketId: number): TestHexAddress =>
    llamma?.collateralByIndex?.[marketId] ?? BTC_ASSET;
  const collateralSet = new Set<string>();
  for (let marketId = 0; marketId < marketCount; marketId += 1) collateralSet.add(collateralFor(marketId).toLowerCase());

  const ybMarketCount = yb?.marketCount ?? 0;
  const ybAssets = new Set<string>();
  for (let marketId = 0; marketId < ybMarketCount; marketId += 1) {
    ybAssets.add(yieldBasisMarketFor(marketId).assetAddress.toLowerCase());
  }

  const pricedKeys = [...collateralSet, ...ybAssets].map((address) => priceKey(address));
  const json: Record<string, unknown> = {};
  if (pricedKeys.length > 0) {
    json[priceUrl(pricedKeys)] = {
      coins: Object.fromEntries(
        [...new Set(pricedKeys)].map((assetKey) => [
          assetKey,
          {
            price: DEFAULT_COLLATERAL_PRICES[assetKey.slice("ethereum:".length)],
            timestamp: NOW_SEC,
            confidence: 0.99,
          },
        ]),
      ),
    };
  }
  if (scenario.curvePayload !== undefined) {
    json[CURVE_MARKETS_URL] = scenario.curvePayload;
  }

  const rpc: Record<string, AdapterRpcValue> = {};
  if (llamma) {
    rpc[`${CURVE_CONTROLLER_FACTORY}:n_collaterals()`] = marketCount;
    rpc[`${CURVE_CONTROLLER_FACTORY}:collaterals(uint256)`] = (call: AdapterRpcCall) => {
      const decoded = decodeFunctionData({ abi: CURVE_FACTORY_ABI, data: call.data as `0x${string}` });
      return collateralFor(Number(decoded.args[0] ?? 0n));
    };
    rpc[`${CURVE_CONTROLLER_FACTORY}:controllers(uint256)`] = LLAMMA_CONTROLLER;
    rpc[`${CURVE_CONTROLLER_FACTORY}:amms(uint256)`] = LLAMMA_AMM;
    rpc[`${LLAMMA_AMM}:min_band()`] = llamma.bandRange?.min ?? 0;
    rpc[`${LLAMMA_AMM}:max_band()`] = llamma.bandRange?.max ?? 0;
    rpc[`${LLAMMA_AMM}:bands_y(int256)`] = llamma.bandY ?? 10n ** 18n;
    rpc[`${LLAMMA_AMM}:bands_x(int256)`] = llamma.bandX ?? 0n;
    for (const address of collateralSet) {
      rpc[`${address}:symbol()`] = symbolResult(address === ETH_ASSET.toLowerCase() ? "WETH" : "WBTC");
    }
  }
  // The optional Yield Basis leg runs in both input modes, so market_count()
  // must always be answerable (default: no registered markets).
  rpc[`${YIELD_BASIS_FACTORY}:market_count()`] = yb?.failMarketCount ? null : ybMarketCount;
  if (yb) {
    rpc[`${YIELD_BASIS_FACTORY}:markets(uint256)`] = (call: AdapterRpcCall) => {
      const decoded = decodeFunctionData({ abi: YIELD_BASIS_FACTORY_ABI, data: call.data as `0x${string}` });
      const { assetAddress, ltAddress } = yieldBasisMarketFor(Number(decoded.args[0] ?? 0n));
      return encodeFunctionResult({
        abi: YIELD_BASIS_FACTORY_ABI,
        functionName: "markets",
        result: [assetAddress, assetAddress, assetAddress, ltAddress, assetAddress, assetAddress, assetAddress] as const,
      });
    };
    for (const address of ybAssets) {
      const isEth = address === ETH_ASSET.toLowerCase();
      rpc[`${address}:symbol()`] = symbolResult(isEth ? "WETH" : "WBTC");
      rpc[`${address}:decimals()`] = yb.tokenDecimals?.(address) ?? (isEth ? 18 : 8);
    }
    for (let marketId = 0; marketId < ybMarketCount; marketId += 1) {
      const { assetAddress, ltAddress } = yieldBasisMarketFor(marketId);
      rpc[`${ltAddress}:totalSupply()`] = 1n;
      rpc[`${ltAddress}:preview_emergency_withdraw(uint256)`] = () => {
        const [assetAmount, feeAmount] = assetAddress.toLowerCase() === ETH_ASSET.toLowerCase()
          ? [10n * 10n ** 18n, 0n]
          : [2n * 10n ** 8n, 0n];
        return encodeFunctionResult({
          abi: YIELD_BASIS_LT_ABI,
          functionName: "preview_emergency_withdraw",
          result: [assetAmount, feeAmount],
        });
      };
    }
  }

  return { json, rpc };
}

async function runCrvUsd(scenario: CrvUsdScenario = {}, options: { validate?: false } = {}) {
  return runAdapter("crvusd", CRVUSD_COIN_ID, {
    network: crvUsdNetwork(scenario),
    ...(scenario.curvePayload !== undefined ? { config: HTTP_CRVUSD_INPUTS } : {}),
    nowSec: NOW_SEC,
    ...(options.validate === false ? { validate: false as const } : {}),
  });
}

describe("fetchCrvUsdReserves", () => {
  it("rejects untrusted LLAMMA market counts above the adapter cap before scheduling market reads", async () => {
    const run = runCrvUsd({
      llamma: { marketCount: 257 },
      yieldBasis: {},
    });

    await expect(run).rejects.toThrow(
      "crvUSD ControllerFactory n_collaterals invalid: 257 (max 256)",
    );
  });

  it("rejects LLAMMA band spans above the adapter cap before multicall dispatch", async () => {
    const network = installAdapterNetwork(crvUsdNetwork({
      llamma: { marketCount: 1, bandRange: { max: 2048 } },
      yieldBasis: {},
    }));
    const run = runAdapter("crvusd", CRVUSD_COIN_ID, { network, nowSec: NOW_SEC });

    await expect(run).rejects.toThrow(
      "crvUSD LLAMMA band span exceeds operational cap for market 0: 2049 > 2048",
    );
    // The rejection happens before any band read is scheduled and before any
    // DefiLlama price lookup.
    expect(network.rpcCalls.some((call) => call.selector === BANDS_Y_SELECTOR)).toBe(false);
    expect(network.rpcCalls.some((call) => call.selector === BANDS_X_SELECTOR)).toBe(false);
    expect(network.requests.some((request) => request.url.includes("prices/current"))).toBe(false);
  });

  it("streams aggregate LLAMMA band reads above the former global cap per market", async () => {
    const { result, network } = await runCrvUsd({
      llamma: { marketCount: 3, bandRange: { max: 1500 } },
      yieldBasis: {},
    });

    expect(result.metadata).toMatchObject({ directMarketCount: 3, directActiveMarketCount: 3 });
    // 1501 bands x (y + x) per market, every read inside a Multicall3 batch.
    const bandMembers = network.rpcCalls.filter(
      (call) => call.viaMulticall && (call.selector === BANDS_Y_SELECTOR || call.selector === BANDS_X_SELECTOR),
    );
    expect(bandMembers).toHaveLength(3 * 1501 * 2);
  });

  it("drops Yield Basis when its untrusted market count exceeds the adapter cap before scheduling market reads", async () => {
    const { result, network } = await runCrvUsd({
      curvePayload: {
        chains: {
          ethereum: {
            data: [{ collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } }],
          },
        },
      },
      yieldBasis: { marketCount: 257 },
    });

    expect(result.slices).toEqual([{ sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 100, risk: "medium" }]);
    expectWarningEffect(result, "yield-basis-read-failed", "degraded");
    expect(network.rpcCalls.filter((call) => call.method === "eth_call").map((call) => call.selector))
      .toEqual([toFunctionSelector("market_count()")]);
  });

  it("reads every Yield Basis market descriptor in one Multicall3 wave before the withdraw reads", async () => {
    const { result, network } = await runCrvUsd({
      curvePayload: { chains: { ethereum: { data: [] } } },
      yieldBasis: { marketCount: 2 },
    });

    const marketsMembers = network.rpcCalls.filter(
      (call) => call.viaMulticall && call.selector === toFunctionSelector("markets(uint256)"),
    );
    expect(marketsMembers.map((call) => call.data.slice(-8))).toEqual(["00000000", "00000001"]);
    expect(result.metadata).toMatchObject({
      yieldBasisMarketCount: 2,
      yieldBasisActiveMarketCount: 2,
      yieldBasisCollateralUsd: 300,
    });
  });

  it("reads both LLAMMA market collateral descriptors in one Multicall3 wave", async () => {
    const { result, network } = await runCrvUsd({
      llamma: { marketCount: 2, collateralByIndex: { 1: ETH_ASSET } },
      yieldBasis: {},
    });

    const collateralMembers = network.rpcCalls.filter(
      (call) => call.viaMulticall && call.selector === toFunctionSelector("collaterals(uint256)"),
    );
    expect(collateralMembers).toHaveLength(2);
    expect(result.metadata).toMatchObject({
      directMarketCount: 2,
      directActiveMarketCount: 2,
      directCollateralUsd: 110,
    });
  });

  it("loads Yield Basis markets onchain and merges them with direct Curve collateral", async () => {
    const { result } = await runCrvUsd({
      curvePayload: {
        chains: {
          ethereum: {
            data: [
              { collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } },
              { collateral_amount_usd: 50, collateral_token: { symbol: "WETH" } },
            ],
          },
        },
      },
      yieldBasis: { marketCount: 2 },
    });

    expect(result.slices).toEqual([
      { sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 66.7, risk: "medium" },
      { sourceKey: "crvusd:eth",
      name: "ETH", pct: 33.3, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      yieldBasisMarketCount: 2,
      yieldBasisActiveMarketCount: 2,
      yieldBasisCollateralUsd: 300,
    });
  });

  it("continues with direct Curve market data when the optional Yield Basis leg fails", async () => {
    const { result, network } = await runCrvUsd({
      curvePayload: {
        chains: {
          ethereum: {
            data: [{ collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } }],
          },
        },
      },
      yieldBasis: { failMarketCount: true },
    });

    expect(result.slices).toEqual([{ sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 100, risk: "medium" }]);
    expectWarningEffect(result, "yield-basis-read-failed", "degraded");
    expect(result.metadata).toMatchObject({
      directActiveMarketCount: 1,
      yieldBasisActiveMarketCount: 0,
      yieldBasisCollateralUsd: 0,
    });
    const ethCallSelectors = network.rpcCalls
      .filter((call) => call.method === "eth_call")
      .map((call) => call.selector);
    expect(ethCallSelectors.length).toBeGreaterThan(0);
    expect(ethCallSelectors.every((selector) => selector === toFunctionSelector("market_count()"))).toBe(true);
  });

  it("drops the optional Yield Basis leg when token decimals are out of bounds", async () => {
    const { result, network } = await runCrvUsd({
      curvePayload: {
        chains: {
          ethereum: {
            data: [{ collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } }],
          },
        },
      },
      yieldBasis: { marketCount: 1, tokenDecimals: () => 37 },
    });

    expect(result.slices).toEqual([{ sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 100, risk: "medium" }]);
    expectWarningEffect(result, "yield-basis-read-failed", "degraded");
    expect(result.metadata).toMatchObject({ yieldBasisActiveMarketCount: 0 });
    expect(network.rpcCalls.some((call) => call.selector === toFunctionSelector("decimals()"))).toBe(true);
    expect(network.requests.some((request) => request.url.includes("prices/current"))).toBe(false);
  });

  it("loads direct LLAMMA bands onchain when configured for onchain input", async () => {
    const { result, network } = await runCrvUsd({
      llamma: { marketCount: 1, bandRange: { max: 1 }, bandY: 5n * 10n ** 18n, bandX: 1n * 10n ** 18n },
      yieldBasis: {},
    });

    expect(result.slices).toEqual([{ sourceKey: "crvusd:btc",
      name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 100, risk: "medium" }]);
    // Both bands (y) sum per market: 2 bands x 5 units x $100 default price.
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      directMarketCount: 1,
      directActiveMarketCount: 1,
      directCollateralUsd: 1000,
      softLiquidatedCrvUsdUsd: 2,
      bandReadCount: 2,
    });
    const bandMembers = network.rpcCalls.filter(
      (call) => call.selector === BANDS_Y_SELECTOR || call.selector === BANDS_X_SELECTOR,
    );
    expect(bandMembers).toHaveLength(4);
    expect(bandMembers.every((call) => call.viaMulticall)).toBe(true);
  });

  it("fails closed with a degraded warning when the Curve payload's collateral amounts are unreadable", async () => {
    // Upstream drift: collateral_amount_usd renamed/dropped must not publish a
    // silently empty collateral mix.
    const { result } = await runCrvUsd({
      curvePayload: {
        chains: {
          ethereum: {
            data: [
              { collateralUsd: 100, collateral_token: { symbol: "WBTC" } },
              { collateral_amount_usd: "100", collateral_token: { symbol: "WETH" } },
            ],
          },
        },
      },
    }, { validate: false });

    expect(result.slices).toEqual([]);
    expectWarningEffect(result, "curve-markets-unreadable", "degraded");
  });
});
