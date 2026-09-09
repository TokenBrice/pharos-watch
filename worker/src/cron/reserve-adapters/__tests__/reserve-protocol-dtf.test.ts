import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeAbiParameters } from "viem/utils";
import { beforeEach, describe, expect, it } from "vitest";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR, encodeAddress, encodeUint256 } from "../../../lib/evm-selectors";
import { installAdapterNetwork, runAdapter, type AdapterNetwork } from "./reserve-adapter.test-support";

const coin = {
  id: "usd3-reserve-protocol",
  symbol: "USD3",
  contracts: [{ chain: "ethereum", address: "0x0d86883faf4ffd7aeb116390af37746f45b6f378", decimals: 18 }],
};

const MAIN_SELECTOR = "0xdffeadd0";
const ASSET_REGISTRY_SELECTOR = "0x979d7e86";
const BASKET_HANDLER_SELECTOR = "0x2f2439b1";
const TO_ASSET_SELECTOR = "0xcde2be8a";
const BASKETS_NEEDED_SELECTOR = "0x7121c273";
const QUOTE_SELECTOR = "0x3913d11a";
const PRICE_SELECTOR = "0xa035b1fe";
const COLLATERAL_STATUS_SELECTOR = "0x200d2ed2";
const FULLY_COLLATERALIZED_SELECTOR = "0xe45a5b2d";
const REDEMPTION_AVAILABLE_SELECTOR = "0x9926020b";
const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";
const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
const EXCHANGE_RATE_SELECTOR = "0x3ba0b9a9";
const UNDERLYING_COMET_SELECTOR = "0x97008d6c";
const COMET_BASE_TOKEN_SELECTOR = "0xc55dae63";

const RTOKEN = "0x0d86883faf4ffd7aeb116390af37746f45b6f378";
const MAIN = "0x81117e3e98910c3dcf956b5fc97a7212e047acf4";
const ASSET_REGISTRY = "0xd75c9768c8ec003b792afac35d0bbacb44b5e500";
const BASKET_HANDLER = "0x19835e5817a6fdc944100e86da2fce86327457b8";
const SUSDS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
const WCUSDCV3 = "0x27f2f159fe990ba83d57f39fd69661764bebf37a";
const STEAK_USDC = "0xbeef01735c132ada46aa9aa4c54623caa92a64cb";
const SUSDS_ASSET = "0x4fd189996b5344eb4cf9c749b97c7424d399d24e";
const WCUSDCV3_ASSET = "0x4d6f9a0f0f57a8179a146f37dd93d558073b814f";
const STEAK_USDC_ASSET = "0xb1327ead6ab9a1e363c4fc61648bd3131a587e39";
const EUSD_RTOKEN = "0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f";
const EUSD_MAIN = "0x7697ae4def3c3cd52493ba3a6f57fc6d8c59108a";
const EUSD_ASSET_REGISTRY = "0x9b85ac04a09c8c813c37de9b3d563c2d3f936162";
const EUSD_BASKET_HANDLER = "0x6d309297dddfea104a6e89a132e2f05ce3828e07";
const WCUSDT_V3 = "0xeb74ec1d4c1dab412d5d6674f6833fd19d3118ce";
const STATIC_AAVE_USDC = "0x0adc69041a2b086f8772acce2a754f410f211bed";
const WCUSDT_V3_ASSET = "0xa52f93e61edf1b77b2d680945f3ea4e84bb825d3";
const STATIC_AAVE_USDC_ASSET = "0x56bcd730040417b871cdf2549564ebb3c88730c9";
const USDS = "0xdc035d45d973e3ec169d2276ddab16f1e407384f";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const COMET_USDC = "0xc3d688b66703497daa19211eedff47f25384cdc3";
const COMET_USDT = "0x3afdc9bca9213a35503b077a6072f3d0d5ab0840";
const ONE = 1_000_000_000_000_000_000n;

function encodeAddressResult(address: string): `0x${string}` {
  return `0x${encodeAddress(address)}`;
}

function encodeBoolResult(value: boolean): `0x${string}` {
  return `0x${encodeUint256(value ? 1n : 0n)}`;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function createOnchainConfig(twoComponents = false): LiveReservesConfig {
  return {
    adapter: "reserve-protocol-dtf",
    version: 1,
    semantics: "collateral-mix",
    breakerScope: "usd3-reserve-protocol",
    display: {
      url: "https://app.reserve.org/ethereum/token/0x0d86883faf4ffd7aeb116390af37746f45b6f378",
      label: "Reserve Protocol",
    },
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
    },
    params: {
      rpcUrl: "https://ethereum-rpc.publicnode.com",
      fallbackRpcUrl: "https://eth.llamarpc.com",
      assets: [
        {
          address: SUSDS,
          name: "Savings USDS",
          risk: "low",
          coinId: "susds-sky",
          depType: "collateral",
        },
        {
          address: WCUSDCV3,
          name: "Wrapped Compound USDCv3",
          risk: "medium",
          coinId: "usdc-circle",
          depType: "collateral",
        },
        ...(!twoComponents ? [{
          address: STATIC_AAVE_USDC,
          name: "Static Aave Ethereum USDC",
          risk: "medium",
          coinId: "usdc-circle",
          depType: "collateral",
        },
        {
          address: STEAK_USDC,
          name: "Steakhouse USDC strategy",
          risk: "medium",
          coinId: "steakusdc-steakhouse",
          depType: "collateral",
        }] : []),
      ],
    },
  };
}

let signal: AbortSignal;
let activeNetwork: AdapterNetwork;

interface MockReserveProtocolOnchainOptions {
  statusByAsset?: Map<string, bigint>;
  redemptionAvailable?: bigint | null;
  totalSupply?: bigint | null;
  fullyCollateralized?: boolean;
  basketStatus?: bigint | null;
  unreadableValuationAsset?: string;
  pluginPricesOnly?: boolean;
  quoteEntries?: Array<{ address: `0x${string}`; quantity: bigint }>;
  abort?: { controller: AbortController; reason: Error };
}

function mockReserveProtocolOnchain(options: MockReserveProtocolOnchainOptions = {}): void {
  const {
    statusByAsset = new Map<string, bigint>(),
    redemptionAvailable = 40n * ONE,
    totalSupply = 100n * ONE,
    fullyCollateralized = true,
    basketStatus = 0n,
    unreadableValuationAsset,
    quoteEntries = [
      { address: SUSDS, quantity: 25n * ONE },
      { address: STATIC_AAVE_USDC, quantity: 25_000_000n },
      { address: WCUSDCV3, quantity: 25_000_000n },
      { address: STEAK_USDC, quantity: 25n * ONE },
    ],
  } = options;
  const shouldAbort = () => {
    if (options.abort) {
      options.abort.controller.abort(options.abort.reason);
      throw new Error("rpc aborted");
    }
  };
  activeNetwork = installAdapterNetwork({
    block: { number: 12345, timestamp: 1776154391 },
    rpc: {
      [`${RTOKEN}:${MAIN_SELECTOR}`]: encodeAddressResult(MAIN),
      [`${MAIN}:${ASSET_REGISTRY_SELECTOR}`]: encodeAddressResult(ASSET_REGISTRY),
      [`${MAIN}:${BASKET_HANDLER_SELECTOR}`]: encodeAddressResult(BASKET_HANDLER),
      [`${BASKET_HANDLER}:${FULLY_COLLATERALIZED_SELECTOR}`]: encodeBoolResult(fullyCollateralized),
      [`${BASKET_HANDLER}:${QUOTE_SELECTOR}`]: encodeAbiParameters(
        [{ type: "address[]" }, { type: "uint256[]" }],
        [quoteEntries.map((entry) => entry.address), quoteEntries.map((entry) => entry.quantity)],
      ),
      [`${ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${encodeAddress(SUSDS)}`]: encodeAddressResult(SUSDS_ASSET),
      [`${ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${encodeAddress(WCUSDCV3)}`]: encodeAddressResult(WCUSDCV3_ASSET),
      [`${ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${encodeAddress(STATIC_AAVE_USDC)}`]: encodeAddressResult(STATIC_AAVE_USDC_ASSET),
      [`${ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${encodeAddress(STEAK_USDC)}`]: encodeAddressResult(STEAK_USDC_ASSET),
      [`${SUSDS_ASSET}:${PRICE_SELECTOR}`]: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]),
      [`${WCUSDCV3_ASSET}:${PRICE_SELECTOR}`]: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]),
      [`${STATIC_AAVE_USDC_ASSET}:${PRICE_SELECTOR}`]: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]),
      [`${STEAK_USDC_ASSET}:${PRICE_SELECTOR}`]: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]),
      [`${SUSDS}:${ERC4626_ASSET_SELECTOR}`]: options.pluginPricesOnly ? null : encodeAddressResult(USDS),
      [`${STATIC_AAVE_USDC}:${ERC4626_ASSET_SELECTOR}`]: options.pluginPricesOnly ? null : encodeAddressResult(USDC),
      [`${STEAK_USDC}:${ERC4626_ASSET_SELECTOR}`]: options.pluginPricesOnly ? null : encodeAddressResult(USDC),
      [`${WCUSDCV3}:${UNDERLYING_COMET_SELECTOR}`]: options.pluginPricesOnly ? null : encodeAddressResult(COMET_USDC),
      [`${COMET_USDC}:${COMET_BASE_TOKEN_SELECTOR}`]: encodeAddressResult(USDC),
      [`${RTOKEN}:${BASKETS_NEEDED_SELECTOR}`]: 100n * ONE,
      [`${RTOKEN}:${REDEMPTION_AVAILABLE_SELECTOR}`]: redemptionAvailable,
      [`${RTOKEN}:${TOTAL_SUPPLY_SELECTOR}`]: totalSupply,
      [`${BASKET_HANDLER}:${COLLATERAL_STATUS_SELECTOR}`]: basketStatus,
      [`${SUSDS}:${DECIMALS_SELECTOR}`]: 18n,
      [`${WCUSDCV3}:${DECIMALS_SELECTOR}`]: 6n,
      [`${STATIC_AAVE_USDC}:${DECIMALS_SELECTOR}`]: 6n,
      [`${STEAK_USDC}:${DECIMALS_SELECTOR}`]: 18n,
      [`${USDS}:${DECIMALS_SELECTOR}`]: 18n,
      [`${USDC}:${DECIMALS_SELECTOR}`]: 6n,
      [`${SUSDS}:${CONVERT_TO_ASSETS_SELECTOR}`]: () => {
        shouldAbort();
        return normalizeAddress(unreadableValuationAsset ?? "") === normalizeAddress(SUSDS)
          ? null
          : 27_500_000_000_000_000_000n;
      },
      [`${STATIC_AAVE_USDC}:${CONVERT_TO_ASSETS_SELECTOR}`]: () => {
        shouldAbort();
        return normalizeAddress(unreadableValuationAsset ?? "") === normalizeAddress(STATIC_AAVE_USDC)
          ? null
          : 26_000_000n;
      },
      [`${STEAK_USDC}:${CONVERT_TO_ASSETS_SELECTOR}`]: () => {
        shouldAbort();
        return normalizeAddress(unreadableValuationAsset ?? "") === normalizeAddress(STEAK_USDC)
          ? null
          : 26_500_000n;
      },
      [`${WCUSDCV3}:${EXCHANGE_RATE_SELECTOR}`]: 1_050_000n,
      [`${SUSDS_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: statusByAsset.get(normalizeAddress(SUSDS_ASSET)) ?? 0n,
      [`${WCUSDCV3_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: statusByAsset.get(normalizeAddress(WCUSDCV3_ASSET)) ?? 0n,
      [`${STATIC_AAVE_USDC_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: statusByAsset.get(normalizeAddress(STATIC_AAVE_USDC_ASSET)) ?? 0n,
      [`${STEAK_USDC_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: statusByAsset.get(normalizeAddress(STEAK_USDC_ASSET)) ?? 0n,
    },
  });
}

async function fetchReserveProtocolDtfReserves(
  coinArg: typeof coin,
  config: LiveReservesConfig,
  abortSignal: AbortSignal,
  ctx?: { nowSec?: number },
) {
  const { result } = await runAdapter(
    "reserve-protocol-dtf",
    { ...coinArg, liveReservesConfig: config } as never,
    { network: activeNetwork, signal: abortSignal, ...(ctx?.nowSec == null ? {} : { nowSec: ctx.nowSec }) },
  );
  return result;
}

beforeEach(() => {
  signal = new AbortController().signal;
  activeNetwork = installAdapterNetwork();
});

describe("reserve-protocol-dtf adapter", () => {
  it("reads Reserve Protocol quote and asset plugin prices directly onchain", async () => {
    const config = createOnchainConfig(true);
    mockReserveProtocolOnchain({
      quoteEntries: [{ address: SUSDS, quantity: 50n * ONE }, { address: WCUSDCV3, quantity: 50_000_000n }],
      redemptionAvailable: null,
      totalSupply: null,
      pluginPricesOnly: true,
    });

    const result = await fetchReserveProtocolDtfReserves(coin as never, config, signal);

    expect(result.slices).toEqual([
      { sourceKey: "reserve-protocol-dtf:0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", name: "Savings USDS", pct: 50, risk: "low", coinId: "susds-sky", depType: "collateral" },
      { sourceKey: "reserve-protocol-dtf:0x27f2f159fe990ba83d57f39fd69661764bebf37a", name: "Wrapped Compound USDCv3", pct: 50, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      unknownExposurePct: 0,
      componentCount: 2,
      totalQuotedValueUsd: 100,
      fullyCollateralized: true,
      details: {
        proofKind: "reserve-protocol-dtf-direct-onchain",
        rTokenAddress: RTOKEN,
        mainAddress: MAIN,
        assetRegistry: ASSET_REGISTRY,
        basketHandler: BASKET_HANDLER,
        quoteAmount: (100n * ONE).toString(),
      },
    });
  });

  it("emits throttle-open redemption capacity capped by RToken total supply", async () => {
    mockReserveProtocolOnchain({ redemptionAvailable: 120n * ONE, totalSupply: 100n * ONE });

    const result = await fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal);
    expect(result.metadata?.observedBlock).toEqual({ chain: "ethereum", number: 12345, timestamp: 1776154391 });
    expect(activeNetwork.rpcCalls.filter((call) => call.method === "eth_call").every((call) => call.block === "0x3039")).toBe(true);

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 100,
      capacityRatioOfSupply: 1,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
    });
    expect(result.metadata?.redemption?.routeStatusReason).toContain("redemptionAvailable() throttle read");
  });

  it("emits a complete same-run USD3 redemption-basket valuation", async () => {
    const observedAt = Date.UTC(2026, 7, 12, 12) / 1_000;
    mockReserveProtocolOnchain();

    const result = await fetchReserveProtocolDtfReserves(
      coin as never,
      createOnchainConfig(),
      signal,
      { nowSec: observedAt },
    );

    const valuation = result.metadata?.redemption?.outputValuation;
    expect(valuation).toMatchObject({
      sourceId: `reserve-protocol-dtf:basket-nav:${RTOKEN}`,
      observedAt,
      unitValueUsd: 1.0625,
      basketWeights: [
        { assetId: "susds-sky" },
        { assetId: "usdc-circle" },
        { assetId: "steakusdc-steakhouse" },
      ],
    });
    expect(valuation!.unitValueUsd).toBeGreaterThan(1);
    expect(valuation!.unitValueUsd).toBeLessThan(1.2);
    expect(valuation!.basketWeights.reduce((sum, leg) => sum + leg.weight, 0)).toBeCloseTo(1, 10);
  });

  it("withholds output valuation when one leg is unreadable but preserves capacity", async () => {
    mockReserveProtocolOnchain({ unreadableValuationAsset: STEAK_USDC });

    const result = await fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal);

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 40,
      capacityRatioOfSupply: 0.4,
      routeStatus: "open",
    });
    expect(result.metadata?.redemption?.outputValuation).toBeUndefined();
  });

  it("propagates cron aborts from the redemption output valuation instead of swallowing them", async () => {
    const controller = new AbortController();
    const reason = new Error("cron timed out");
    mockReserveProtocolOnchain({ abort: { controller, reason } });

    // The valuation legs are the only reads inside the swallowed try/catch; abort
    // mid-valuation and assert the reason propagates rather than degrading to a
    // null output valuation.
    await expect(
      fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), controller.signal),
    ).rejects.toBe(reason);
  });


  it("withholds output valuation when the live basket diverges from configured output assets", async () => {
    mockReserveProtocolOnchain({
      quoteEntries: [
        { address: SUSDS, quantity: 50n * ONE },
        { address: WCUSDCV3, quantity: 50_000_000n },
      ],
    });

    const result = await fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal);

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 40, routeStatus: "open" });
    expect(result.metadata?.redemption?.outputValuation).toBeUndefined();
    expect(activeNetwork.rpcCalls.some((call) => call.selector === CONVERT_TO_ASSETS_SELECTOR)).toBe(false);
  });

  it("reads eUSD's three-token basket and emits its RToken redemption throttle", async () => {
    const eusdCoin = {
      id: "eusd-electronic-usd",
      symbol: "EUSD",
      contracts: [{ chain: "ethereum", address: EUSD_RTOKEN, decimals: 18 }],
    };
    const config: LiveReservesConfig = {
      adapter: "reserve-protocol-dtf",
      version: 1,
      semantics: "collateral-mix",
      breakerScope: "eusd-electronic-usd",
      display: {
        url: `https://app.reserve.org/ethereum/token/${EUSD_RTOKEN}/overview`,
        label: "Reserve Protocol",
      },
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        rpcUrl: "https://ethereum-rpc.publicnode.com",
        fallbackRpcUrl: "https://eth.llamarpc.com",
        assets: [
          {
            address: STATIC_AAVE_USDC,
            name: "Static Aave Ethereum USDC",
            risk: "low",
            coinId: "usdc-circle",
            depType: "collateral",
          },
          {
            address: WCUSDCV3,
            name: "Wrapped Compound USDCv3",
            risk: "low",
            coinId: "usdc-circle",
            depType: "collateral",
          },
          {
            address: WCUSDT_V3,
            name: "Wrapped Compound USDTv3",
            risk: "low",
            coinId: "usdt-tether",
            depType: "collateral",
          },
        ],
      },
    };
    const totalSupply = 22_834_920_564_803_451_236_744_370n;
    const wcUsdcQuantity = 7_535_523_786_385n;
    const wcUsdtQuantity = 7_535_523_786_385n;
    const staticAaveUsdcQuantity = 7_763_872_992_033n;

    activeNetwork = installAdapterNetwork({
      block: { number: 12345, timestamp: 1776154391 },
      rpc: {
        [`${EUSD_RTOKEN}:${MAIN_SELECTOR}`]: encodeAddressResult(EUSD_MAIN),
        [`${EUSD_MAIN}:${ASSET_REGISTRY_SELECTOR}`]: encodeAddressResult(EUSD_ASSET_REGISTRY),
        [`${EUSD_MAIN}:${BASKET_HANDLER_SELECTOR}`]: encodeAddressResult(EUSD_BASKET_HANDLER),
        [`${EUSD_BASKET_HANDLER}:${FULLY_COLLATERALIZED_SELECTOR}`]: encodeBoolResult(true),
        [`${EUSD_BASKET_HANDLER}:${QUOTE_SELECTOR}`]: encodeAbiParameters(
          [{ type: "address[]" }, { type: "uint256[]" }],
          [
            [WCUSDCV3, WCUSDT_V3, STATIC_AAVE_USDC],
            [wcUsdcQuantity, wcUsdtQuantity, staticAaveUsdcQuantity],
          ],
        ),
        [`${EUSD_ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${encodeAddress(WCUSDCV3)}`]: encodeAddressResult(WCUSDCV3_ASSET),
        [`${EUSD_ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${encodeAddress(WCUSDT_V3)}`]: encodeAddressResult(WCUSDT_V3_ASSET),
        [`${EUSD_ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${encodeAddress(STATIC_AAVE_USDC)}`]: encodeAddressResult(STATIC_AAVE_USDC_ASSET),
        [`${WCUSDCV3_ASSET}:${PRICE_SELECTOR}`]: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]),
        [`${WCUSDT_V3_ASSET}:${PRICE_SELECTOR}`]: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]),
        [`${STATIC_AAVE_USDC_ASSET}:${PRICE_SELECTOR}`]: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]),
        [`${STATIC_AAVE_USDC}:${ERC4626_ASSET_SELECTOR}`]: encodeAddressResult(USDC),
        [`${WCUSDCV3}:${UNDERLYING_COMET_SELECTOR}`]: encodeAddressResult(COMET_USDC),
        [`${WCUSDT_V3}:${UNDERLYING_COMET_SELECTOR}`]: encodeAddressResult(COMET_USDT),
        [`${COMET_USDC}:${COMET_BASE_TOKEN_SELECTOR}`]: encodeAddressResult(USDC),
        [`${COMET_USDT}:${COMET_BASE_TOKEN_SELECTOR}`]: encodeAddressResult(USDT),
        [`${EUSD_RTOKEN}:${BASKETS_NEEDED_SELECTOR}`]: totalSupply,
        [`${EUSD_RTOKEN}:${REDEMPTION_AVAILABLE_SELECTOR}`]: 5_000_000n * ONE,
        [`${EUSD_RTOKEN}:${TOTAL_SUPPLY_SELECTOR}`]: totalSupply,
        [`${EUSD_BASKET_HANDLER}:${COLLATERAL_STATUS_SELECTOR}`]: 0n,
        [`${WCUSDCV3}:${DECIMALS_SELECTOR}`]: 6n,
        [`${WCUSDT_V3}:${DECIMALS_SELECTOR}`]: 6n,
        [`${STATIC_AAVE_USDC}:${DECIMALS_SELECTOR}`]: 6n,
        [`${USDC}:${DECIMALS_SELECTOR}`]: 6n,
        [`${USDT}:${DECIMALS_SELECTOR}`]: 6n,
        [`${STATIC_AAVE_USDC}:${CONVERT_TO_ASSETS_SELECTOR}`]: staticAaveUsdcQuantity,
        [`${WCUSDCV3}:${EXCHANGE_RATE_SELECTOR}`]: 1_000_000n,
        [`${WCUSDT_V3}:${EXCHANGE_RATE_SELECTOR}`]: 1_000_000n,
        [`${WCUSDCV3_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: 0n,
        [`${WCUSDT_V3_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: 0n,
        [`${STATIC_AAVE_USDC_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: 0n,
      },
    });

    const observedAt = Date.UTC(2026, 7, 12, 12) / 1_000;
    const result = await fetchReserveProtocolDtfReserves(eusdCoin as never, config, signal, { nowSec: observedAt });

    expect(result.slices).toEqual([
      { sourceKey: `reserve-protocol-dtf:${STATIC_AAVE_USDC.toLowerCase()}`, name: "Static Aave Ethereum USDC", pct: 34, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: `reserve-protocol-dtf:${WCUSDCV3.toLowerCase()}`, name: "Wrapped Compound USDCv3", pct: 33, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: `reserve-protocol-dtf:${WCUSDT_V3.toLowerCase()}`, name: "Wrapped Compound USDTv3", pct: 33, risk: "low", coinId: "usdt-tether", depType: "collateral" },
    ]);
    expect(result.metadata).toMatchObject({
      componentCount: 3,
      fullyCollateralized: true,
      basketStatus: "0",
      details: {
        rTokenAddress: EUSD_RTOKEN,
        mainAddress: EUSD_MAIN,
        assetRegistry: EUSD_ASSET_REGISTRY,
        basketHandler: EUSD_BASKET_HANDLER,
      },
      redemption: {
        capacityUsd: 5_000_000,
        capacityRatioOfSupply: 5_000_000 / 22_834_920.56480345,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        outputValuation: {
          sourceId: `reserve-protocol-dtf:basket-nav:${EUSD_RTOKEN}`,
          observedAt,
          unitValueUsd: 0.9999999999999802,
          basketWeights: [
            { assetId: "usdc-circle" },
            { assetId: "usdt-tether" },
          ],
        },
      },
    });
    expect(result.metadata?.redemption?.outputValuation?.basketWeights.reduce((sum, leg) => sum + leg.weight, 0))
      .toBeCloseTo(1, 10);
  });

  it("emits zero capacity when the redemption throttle is exhausted", async () => {
    mockReserveProtocolOnchain({ redemptionAvailable: 0n });

    const result = await fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal);

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      capacityRatioOfSupply: 0,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
    });
  });

  it("degrades redemption telemetry when the basket is not sound", async () => {
    mockReserveProtocolOnchain({ fullyCollateralized: false, basketStatus: 1n });

    const result = await fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal);

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 40,
      routeStatus: "degraded",
      routeStatusSource: "onchain",
    });
    expect(result.metadata?.redemption?.routeStatusReason).toContain(
      "basket status is 1 and fullyCollateralized() is false",
    );
  });

  it.each([
    ["redemptionAvailable()", { redemptionAvailable: null }],
    ["totalSupply()", { totalSupply: null }],
    ["BasketHandler.status()", { basketStatus: null }],
  ])("withholds redemption telemetry when %s fails", async (_label, options) => {
    mockReserveProtocolOnchain(options);

    const result = await fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal);

    expect(result.slices).toHaveLength(4);
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("keeps IFFY collateral published with a degraded status warning", async () => {
    mockReserveProtocolOnchain({ statusByAsset: new Map([[SUSDS_ASSET, 1n]]) });

    const result = await fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal);

    expect(result.slices).toEqual([
      { sourceKey: `reserve-protocol-dtf:${SUSDS.toLowerCase()}`, name: "Savings USDS", pct: 25, risk: "low", coinId: "susds-sky", depType: "collateral" },
      { sourceKey: `reserve-protocol-dtf:${STATIC_AAVE_USDC.toLowerCase()}`, name: "Static Aave Ethereum USDC", pct: 25, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: `reserve-protocol-dtf:${WCUSDCV3.toLowerCase()}`, name: "Wrapped Compound USDCv3", pct: 25, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: `reserve-protocol-dtf:${STEAK_USDC.toLowerCase()}`, name: "Steakhouse USDC strategy", pct: 25, risk: "medium", coinId: "steakusdc-steakhouse", depType: "collateral" },
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "reserve-protocol-dtf-collateral-status",
        effect: "degraded",
        message: expect.stringContaining("IFFY (1)"),
      }),
    );
  });

  it("rejects DISABLED collateral status instead of publishing a stale basket", async () => {
    mockReserveProtocolOnchain({ statusByAsset: new Map([[SUSDS_ASSET, 2n]]) });

    await expect(fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal)).rejects.toThrow(
      /collateral status is DISABLED \(2\)/,
    );
  });
});
