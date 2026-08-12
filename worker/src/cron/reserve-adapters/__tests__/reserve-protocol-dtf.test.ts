import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeAbiParameters } from "viem/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR, encodeAddress, encodeUint256 } from "../../../lib/evm-selectors";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainRawCall = vi.fn();
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchOnchainRawCall,
    fetchOnchainUint256,
    makeOnchainCallers: vi.fn((input, options) => ({
      uint256: (contract: string, data: string) =>
        fetchOnchainUint256({
          ...options,
          contract,
          data,
          rpcMode: input.rpcMode,
          chain: input.chain,
        }),
      raw: (contract: string, data: string) =>
        fetchOnchainRawCall({
          ...options,
          contract,
          data,
          rpcMode: input.rpcMode,
          chain: input.chain,
        }),
    })),
  };
});

import { adaptReserveProtocolDtfRows, fetchReserveProtocolDtfReserves } from "../reserve-protocol-dtf";
import { fetchOnchainRawCall, fetchOnchainUint256 } from "../helpers";

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

const signal = AbortSignal.timeout(5_000);

function encodeAddressResult(address: string): `0x${string}` {
  return `0x${encodeAddress(address)}`;
}

function encodeBoolResult(value: boolean): `0x${string}` {
  return `0x${encodeUint256(value ? 1n : 0n)}`;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function createOnchainConfig(): LiveReservesConfig {
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
        {
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
        },
      ],
    },
  };
}

interface MockReserveProtocolOnchainOptions {
  statusByAsset?: Map<string, bigint>;
  redemptionAvailable?: bigint | null;
  totalSupply?: bigint | null;
  fullyCollateralized?: boolean;
  basketStatus?: bigint | null;
  unreadableValuationAsset?: string;
  quoteEntries?: Array<{ address: `0x${string}`; quantity: bigint }>;
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
  vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => {
    const normalizedContract = normalizeAddress(contract);
    if (normalizedContract === RTOKEN && data === MAIN_SELECTOR) return encodeAddressResult(MAIN);
    if (normalizedContract === MAIN && data === ASSET_REGISTRY_SELECTOR) return encodeAddressResult(ASSET_REGISTRY);
    if (normalizedContract === MAIN && data === BASKET_HANDLER_SELECTOR) return encodeAddressResult(BASKET_HANDLER);
    if (normalizedContract === BASKET_HANDLER && data === FULLY_COLLATERALIZED_SELECTOR)
      return encodeBoolResult(fullyCollateralized);
    if (normalizedContract === BASKET_HANDLER && data.startsWith(QUOTE_SELECTOR)) {
      return encodeAbiParameters(
        [{ type: "address[]" }, { type: "uint256[]" }],
        [
          quoteEntries.map((entry) => entry.address),
          quoteEntries.map((entry) => entry.quantity),
        ],
      );
    }
    if (normalizedContract === ASSET_REGISTRY && data === `${TO_ASSET_SELECTOR}${encodeAddress(SUSDS)}`) {
      return encodeAddressResult(SUSDS_ASSET);
    }
    if (normalizedContract === ASSET_REGISTRY && data === `${TO_ASSET_SELECTOR}${encodeAddress(WCUSDCV3)}`) {
      return encodeAddressResult(WCUSDCV3_ASSET);
    }
    if (normalizedContract === ASSET_REGISTRY && data === `${TO_ASSET_SELECTOR}${encodeAddress(STATIC_AAVE_USDC)}`) {
      return encodeAddressResult(STATIC_AAVE_USDC_ASSET);
    }
    if (normalizedContract === ASSET_REGISTRY && data === `${TO_ASSET_SELECTOR}${encodeAddress(STEAK_USDC)}`) {
      return encodeAddressResult(STEAK_USDC_ASSET);
    }
    if (
      [SUSDS_ASSET, WCUSDCV3_ASSET, STATIC_AAVE_USDC_ASSET, STEAK_USDC_ASSET].includes(normalizedContract) &&
      data === PRICE_SELECTOR
    ) {
      return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]);
    }
    if (data === ERC4626_ASSET_SELECTOR) {
      if (normalizedContract === SUSDS) return encodeAddressResult(USDS);
      if (normalizedContract === STATIC_AAVE_USDC || normalizedContract === STEAK_USDC) {
        return encodeAddressResult(USDC);
      }
    }
    if (data === UNDERLYING_COMET_SELECTOR && normalizedContract === WCUSDCV3) {
      return encodeAddressResult(COMET_USDC);
    }
    if (data === COMET_BASE_TOKEN_SELECTOR && normalizedContract === COMET_USDC) {
      return encodeAddressResult(USDC);
    }
    return null;
  });

  vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
    const normalizedContract = normalizeAddress(contract);
    if (normalizedContract === RTOKEN && data === BASKETS_NEEDED_SELECTOR) return 100n * ONE;
    if (normalizedContract === RTOKEN && data === REDEMPTION_AVAILABLE_SELECTOR) return redemptionAvailable;
    if (normalizedContract === RTOKEN && data === TOTAL_SUPPLY_SELECTOR) return totalSupply;
    if (normalizedContract === BASKET_HANDLER && data === COLLATERAL_STATUS_SELECTOR) return basketStatus;
    if (normalizedContract === SUSDS && data === DECIMALS_SELECTOR) return 18n;
    if ([WCUSDCV3, STATIC_AAVE_USDC].includes(normalizedContract) && data === DECIMALS_SELECTOR) return 6n;
    if (normalizedContract === STEAK_USDC && data === DECIMALS_SELECTOR) return 18n;
    if (normalizedContract === USDS && data === DECIMALS_SELECTOR) return 18n;
    if (normalizedContract === USDC && data === DECIMALS_SELECTOR) return 6n;
    if (data.startsWith(CONVERT_TO_ASSETS_SELECTOR)) {
      if (normalizedContract === unreadableValuationAsset) return null;
      if (normalizedContract === SUSDS) return 27_500_000_000_000_000_000n;
      if (normalizedContract === STATIC_AAVE_USDC) return 26_000_000n;
      if (normalizedContract === STEAK_USDC) return 26_500_000n;
    }
    if (normalizedContract === WCUSDCV3 && data === EXCHANGE_RATE_SELECTOR) return 1_050_000n;
    if (
      [SUSDS_ASSET, WCUSDCV3_ASSET, STATIC_AAVE_USDC_ASSET, STEAK_USDC_ASSET].includes(normalizedContract) &&
      data === COLLATERAL_STATUS_SELECTOR
    ) {
      return statusByAsset.get(normalizedContract) ?? 0n;
    }
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reserve-protocol-dtf adapter", () => {
  it("maps reviewed basket components by address and preserves unverified freshness", () => {
    const result = adaptReserveProtocolDtfRows(
      [
        {
          address: "0x0d86883FAf4FfD7aEb116390af37746F45b6f378",
          name: "Web 3 Dollar",
          symbol: "USD3",
          price: 1.09,
          marketCap: 4_500_000,
          chainId: 1,
          status: "active",
          basket: [
            {
              address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
              symbol: "sUSDS",
              name: "Savings USDS",
              weight: "50",
            },
            {
              address: "0x27F2f159Fe990Ba83D57f39Fd69661764BEbf37a",
              symbol: "wcUSDCv3",
              name: "Wrapped cUSDCv3",
              weight: "50",
            },
          ],
        },
      ],
      coin as never,
      [
        {
          address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
          name: "Savings USDS",
          risk: "low",
          coinId: "susds-sky",
          depType: "collateral",
        },
        {
          address: "0x27F2f159Fe990Ba83D57f39Fd69661764BEbf37a",
          name: "Wrapped Compound USDCv3",
          risk: "medium",
          coinId: "usdc-circle",
          depType: "collateral",
        },
      ],
      "https://api.reserve.org/discover/dtfs",
    );

    expect(result.slices).toEqual([
      { name: "Savings USDS", pct: 50, risk: "low", coinId: "susds-sky", depType: "collateral" },
      { name: "Wrapped Compound USDCv3", pct: 50, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.unknownExposurePct).toBe(0);
  });

  it("degrades material unmapped basket exposure", () => {
    const result = adaptReserveProtocolDtfRows(
      [
        {
          address: "0x0d86883faf4ffd7aeb116390af37746f45b6f378",
          symbol: "USD3",
          basket: [{ address: "0x0000000000000000000000000000000000000001", symbol: "UNKNOWN", weight: 100 }],
        },
      ],
      coin as never,
      [],
      "https://api.reserve.org/discover/dtfs",
    );

    expect(result.slices[0]).toMatchObject({
      name: "Unmapped Reserve Protocol DTF asset: UNKNOWN",
      risk: "high",
      pct: 100,
    });
    expect(result.warnings?.[0]).toMatchObject({
      code: "reserve-protocol-dtf-unknown-component",
      effect: "degraded",
    });
  });

  it("reads Reserve Protocol quote and asset plugin prices directly onchain", async () => {
    const config: LiveReservesConfig = {
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
        ],
      },
    };

    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => {
      const normalizedContract = normalizeAddress(contract);
      if (normalizedContract === RTOKEN && data === MAIN_SELECTOR) return encodeAddressResult(MAIN);
      if (normalizedContract === MAIN && data === ASSET_REGISTRY_SELECTOR) return encodeAddressResult(ASSET_REGISTRY);
      if (normalizedContract === MAIN && data === BASKET_HANDLER_SELECTOR) return encodeAddressResult(BASKET_HANDLER);
      if (normalizedContract === BASKET_HANDLER && data === FULLY_COLLATERALIZED_SELECTOR)
        return encodeBoolResult(true);
      if (normalizedContract === BASKET_HANDLER && data.startsWith(QUOTE_SELECTOR)) {
        return encodeAbiParameters(
          [{ type: "address[]" }, { type: "uint256[]" }],
          [
            [SUSDS, WCUSDCV3],
            [50n * ONE, 50_000_000n],
          ],
        );
      }
      if (normalizedContract === ASSET_REGISTRY && data === `${TO_ASSET_SELECTOR}${encodeAddress(SUSDS)}`) {
        return encodeAddressResult(SUSDS_ASSET);
      }
      if (normalizedContract === ASSET_REGISTRY && data === `${TO_ASSET_SELECTOR}${encodeAddress(WCUSDCV3)}`) {
        return encodeAddressResult(WCUSDCV3_ASSET);
      }
      if ((normalizedContract === SUSDS_ASSET || normalizedContract === WCUSDCV3_ASSET) && data === PRICE_SELECTOR) {
        return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]);
      }
      return null;
    });

    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
      const normalizedContract = normalizeAddress(contract);
      if (normalizedContract === RTOKEN && data === BASKETS_NEEDED_SELECTOR) return 100n * ONE;
      if (normalizedContract === SUSDS && data === DECIMALS_SELECTOR) return 18n;
      if (normalizedContract === WCUSDCV3 && data === DECIMALS_SELECTOR) return 6n;
      if (
        (normalizedContract === SUSDS_ASSET || normalizedContract === WCUSDCV3_ASSET) &&
        data === COLLATERAL_STATUS_SELECTOR
      )
        return 0n;
      return null;
    });

    const result = await fetchReserveProtocolDtfReserves(coin as never, config, signal);

    expect(result.slices).toEqual([
      { name: "Savings USDS", pct: 50, risk: "low", coinId: "susds-sky", depType: "collateral" },
      { name: "Wrapped Compound USDCv3", pct: 50, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
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
    expect(result.metadata?.details).toMatchObject({
      proofKind: "reserve-protocol-dtf-direct-onchain",
      rTokenAddress: RTOKEN,
      mainAddress: MAIN,
      assetRegistry: ASSET_REGISTRY,
      basketHandler: BASKET_HANDLER,
      quoteAmount: (100n * ONE).toString(),
    });
  });

  it("emits throttle-open redemption capacity capped by RToken total supply", async () => {
    mockReserveProtocolOnchain({ redemptionAvailable: 120n * ONE, totalSupply: 100n * ONE });

    const result = await fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal);

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
    expect(vi.mocked(fetchOnchainUint256).mock.calls.some(([call]) => call.data.startsWith(CONVERT_TO_ASSETS_SELECTOR)))
      .toBe(false);
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

    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => {
      const normalizedContract = normalizeAddress(contract);
      if (normalizedContract === EUSD_RTOKEN && data === MAIN_SELECTOR) return encodeAddressResult(EUSD_MAIN);
      if (normalizedContract === EUSD_MAIN && data === ASSET_REGISTRY_SELECTOR)
        return encodeAddressResult(EUSD_ASSET_REGISTRY);
      if (normalizedContract === EUSD_MAIN && data === BASKET_HANDLER_SELECTOR)
        return encodeAddressResult(EUSD_BASKET_HANDLER);
      if (normalizedContract === EUSD_BASKET_HANDLER && data === FULLY_COLLATERALIZED_SELECTOR)
        return encodeBoolResult(true);
      if (normalizedContract === EUSD_BASKET_HANDLER && data.startsWith(QUOTE_SELECTOR)) {
        return encodeAbiParameters(
          [{ type: "address[]" }, { type: "uint256[]" }],
          [
            [WCUSDCV3, WCUSDT_V3, STATIC_AAVE_USDC],
            [wcUsdcQuantity, wcUsdtQuantity, staticAaveUsdcQuantity],
          ],
        );
      }
      const assetByToken = new Map([
        [WCUSDCV3, WCUSDCV3_ASSET],
        [WCUSDT_V3, WCUSDT_V3_ASSET],
        [STATIC_AAVE_USDC, STATIC_AAVE_USDC_ASSET],
      ]);
      if (normalizedContract === EUSD_ASSET_REGISTRY && data.startsWith(TO_ASSET_SELECTOR)) {
        for (const [token, asset] of assetByToken) {
          if (data === `${TO_ASSET_SELECTOR}${encodeAddress(token)}`) return encodeAddressResult(asset);
        }
      }
      if ([WCUSDCV3_ASSET, WCUSDT_V3_ASSET, STATIC_AAVE_USDC_ASSET].includes(normalizedContract)) {
        if (data === PRICE_SELECTOR) {
          return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]);
        }
      }
      if (data === ERC4626_ASSET_SELECTOR && normalizedContract === STATIC_AAVE_USDC) {
        return encodeAddressResult(USDC);
      }
      if (data === UNDERLYING_COMET_SELECTOR && normalizedContract === WCUSDCV3) {
        return encodeAddressResult(COMET_USDC);
      }
      if (data === UNDERLYING_COMET_SELECTOR && normalizedContract === WCUSDT_V3) {
        return encodeAddressResult(COMET_USDT);
      }
      if (data === COMET_BASE_TOKEN_SELECTOR && normalizedContract === COMET_USDC) {
        return encodeAddressResult(USDC);
      }
      if (data === COMET_BASE_TOKEN_SELECTOR && normalizedContract === COMET_USDT) {
        return encodeAddressResult(USDT);
      }
      return null;
    });

    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
      const normalizedContract = normalizeAddress(contract);
      if (normalizedContract === EUSD_RTOKEN && data === BASKETS_NEEDED_SELECTOR) return totalSupply;
      if (normalizedContract === EUSD_RTOKEN && data === REDEMPTION_AVAILABLE_SELECTOR) return 5_000_000n * ONE;
      if (normalizedContract === EUSD_RTOKEN && data === TOTAL_SUPPLY_SELECTOR) return totalSupply;
      if (normalizedContract === EUSD_BASKET_HANDLER && data === COLLATERAL_STATUS_SELECTOR) return 0n;
      if ([WCUSDCV3, WCUSDT_V3, STATIC_AAVE_USDC].includes(normalizedContract) && data === DECIMALS_SELECTOR)
        return 6n;
      if ([USDC, USDT].includes(normalizedContract) && data === DECIMALS_SELECTOR) return 6n;
      if (normalizedContract === STATIC_AAVE_USDC && data.startsWith(CONVERT_TO_ASSETS_SELECTOR)) {
        return staticAaveUsdcQuantity;
      }
      if ([WCUSDCV3, WCUSDT_V3].includes(normalizedContract) && data === EXCHANGE_RATE_SELECTOR) {
        return 1_000_000n;
      }
      if (
        [WCUSDCV3_ASSET, WCUSDT_V3_ASSET, STATIC_AAVE_USDC_ASSET].includes(normalizedContract) &&
        data === COLLATERAL_STATUS_SELECTOR
      )
        return 0n;
      return null;
    });

    const observedAt = Date.UTC(2026, 7, 12, 12) / 1_000;
    const result = await fetchReserveProtocolDtfReserves(eusdCoin as never, config, signal, { nowSec: observedAt });

    expect(result.slices).toEqual([
      { name: "Static Aave Ethereum USDC", pct: 34, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { name: "Wrapped Compound USDCv3", pct: 33, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { name: "Wrapped Compound USDTv3", pct: 33, risk: "low", coinId: "usdt-tether", depType: "collateral" },
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
      { name: "Savings USDS", pct: 25, risk: "low", coinId: "susds-sky", depType: "collateral" },
      { name: "Static Aave Ethereum USDC", pct: 25, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
      { name: "Wrapped Compound USDCv3", pct: 25, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
      { name: "Steakhouse USDC strategy", pct: 25, risk: "medium", coinId: "steakusdc-steakhouse", depType: "collateral" },
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
