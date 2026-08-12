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

const RTOKEN = "0x0d86883faf4ffd7aeb116390af37746f45b6f378";
const MAIN = "0x81117e3e98910c3dcf956b5fc97a7212e047acf4";
const ASSET_REGISTRY = "0xd75c9768c8ec003b792afac35d0bbacb44b5e500";
const BASKET_HANDLER = "0x19835e5817a6fdc944100e86da2fce86327457b8";
const SUSDS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
const WCUSDCV3 = "0x27f2f159fe990ba83d57f39fd69661764bebf37a";
const SUSDS_ASSET = "0x4fd189996b5344eb4cf9c749b97c7424d399d24e";
const WCUSDCV3_ASSET = "0x4d6f9a0f0f57a8179a146f37dd93d558073b814f";
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
}

function mockReserveProtocolOnchain(options: MockReserveProtocolOnchainOptions = {}): void {
  const {
    statusByAsset = new Map<string, bigint>(),
    redemptionAvailable = 40n * ONE,
    totalSupply = 100n * ONE,
    fullyCollateralized = true,
    basketStatus = 0n,
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
    if (normalizedContract === RTOKEN && data === REDEMPTION_AVAILABLE_SELECTOR) return redemptionAvailable;
    if (normalizedContract === RTOKEN && data === TOTAL_SUPPLY_SELECTOR) return totalSupply;
    if (normalizedContract === BASKET_HANDLER && data === COLLATERAL_STATUS_SELECTOR) return basketStatus;
    if (normalizedContract === SUSDS && data === DECIMALS_SELECTOR) return 18n;
    if (normalizedContract === WCUSDCV3 && data === DECIMALS_SELECTOR) return 6n;
    if (
      (normalizedContract === SUSDS_ASSET || normalizedContract === WCUSDCV3_ASSET) &&
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

    expect(result.slices).toHaveLength(2);
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("keeps IFFY collateral published with a degraded status warning", async () => {
    mockReserveProtocolOnchain({ statusByAsset: new Map([[SUSDS_ASSET, 1n]]) });

    const result = await fetchReserveProtocolDtfReserves(coin as never, createOnchainConfig(), signal);

    expect(result.slices).toEqual([
      { name: "Savings USDS", pct: 50, risk: "low", coinId: "susds-sky", depType: "collateral" },
      { name: "Wrapped Compound USDCv3", pct: 50, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
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
