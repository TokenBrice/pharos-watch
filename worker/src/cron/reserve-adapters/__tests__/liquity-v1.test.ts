vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/evm-rpc")>(),
  fetchEvmBlockNumber: vi.fn(async () => 123),
  fetchEvmBlockTimestamp: vi.fn(async () => 1_800_000_000),
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  // `vi.mock` factories are hoisted above static imports, so the shared call
  // mocks have to be pulled in from inside the factory.
  const { makeOnchainCallersMock, makeOnchainMulticall3Mock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchOnchainUint256,
    fetchOnchainMulticall3: makeOnchainMulticall3Mock({
      uint256: fetchOnchainUint256,
      raw: fetchOnchainRawCall,
    }),
    makeOnchainCallers: makeOnchainCallersMock({ uint256: fetchOnchainUint256 }),
    fetchDefiLlamaPrices: vi.fn(),
    probeOptionalRedemptionRateBps: vi.fn(),
  };
});

import { fetchLiquityV1Reserves } from "../liquity-v1";
import {
  fetchDefiLlamaPrices,
  fetchOnchainMulticall3,
  fetchOnchainUint256,
  probeOptionalRedemptionRateBps,
} from "../helpers";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

let signal: AbortSignal;
const coin = { id: "lusd-liquity" } as StablecoinMeta;

const TROVE_MANAGER = "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2";
const PRICE_FEED = "0x4c517D4e2C851CA76d7eC94B805269Df0f2201De";
const COLLATERAL_SELECTOR = "0x887105d3";
const DEBT_SELECTOR = "0x795d26c3";
const MCR_SELECTOR = "0x794e5724";
const GET_TCR_SELECTOR = "0xb82f263d";
const FETCH_PRICE_SELECTOR = "0x0fdb11cf";
const WAD = 10n ** 18n;
const MCR_RAW = 11n * WAD / 10n;

const config: LiveReservesConfig = {
  adapter: "liquity-v1",
  version: 2,
  semantics: "single-asset",
  inputs: {
    primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "alchemy" },
  },
  params: {
    troveManagerAddress: TROVE_MANAGER,
    slice: {
      name: "ETH",
      risk: "very-low",
    },
    redemptionRateProbe: {
      contract: TROVE_MANAGER,
      selector: "0xc52861f2",
      decimals: 18,
    },
  },
};

interface SystemState {
  /** getEntireSystemColl() */
  collateral: bigint | null;
  /** getEntireSystemDebt() */
  debt: bigint | null;
  /** PriceFeed.fetchPrice(): the price redeemCollateral() gates on */
  price: bigint | null;
  /** MCR() */
  mcr: bigint | null;
  /** false makes the batched getTCR() call fail while the others succeed */
  tcrReadable: boolean;
}

const DEFAULT_STATE: SystemState = {
  collateral: 200n * WAD,
  debt: 150_000n * WAD,
  price: 2_000n * WAD,
  mcr: MCR_RAW,
  tcrReadable: true,
};

/** Fake the TroveManager reads, including `_getTCR(price) = coll * price / debt`
 *  computed from the price argument the adapter actually passed. */
function mockSystemReads(overrides: Partial<SystemState> = {}): void {
  const state = { ...DEFAULT_STATE, ...overrides };
  vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
    if (contract === PRICE_FEED && data === FETCH_PRICE_SELECTOR) return state.price;
    if (data === COLLATERAL_SELECTOR) return state.collateral;
    if (data === DEBT_SELECTOR) return state.debt;
    if (data === MCR_SELECTOR) return state.mcr;
    if (data.startsWith(GET_TCR_SELECTOR)) {
      if (!state.tcrReadable) return null;
      if (state.collateral == null || state.debt == null || state.debt === 0n) return null;
      const priceArg = BigInt(`0x${data.slice(GET_TCR_SELECTOR.length)}`);
      return (state.collateral * priceArg) / state.debt;
    }
    throw new Error(`Unexpected liquity-v1 read: ${contract} ${data}`);
  });
}

describe("fetchLiquityV1Reserves", () => {
  beforeEach(() => {
    signal = new AbortController().signal;
    vi.clearAllMocks();
  });

  it("returns a 100% ETH slice with collateralization ratio from Liquity v1 reads", async () => {
    // 200 ETH collateral at $2000 = $400k, debt = 150k LUSD → CR ≈ 2.667
    mockSystemReads();
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 2000]]));

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.slices).toEqual([{
      sourceKey: "liquity-v1:eth",
      name: "ETH",
      pct: 100,
      risk: "very-low",
    }]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      chain: "ethereum",
      troveManagerAddress: TROVE_MANAGER,
      totalCollateralRaw: "200000000000000000000",
      totalDebtRaw: "150000000000000000000000",
      totalDebtUsd: 150_000,
      totalCollateralUsd: 400_000,
      ethPriceUsd: 2000,
      minimumCollateralRatio: 1.1,
      redemption: {
        capacityUsd: 150_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: 50,
      },
      details: {
        proofKind: "liquity-v1-system-collateral",
        protocolPriceRaw: "2000000000000000000000",
        mcrRaw: MCR_RAW.toString(),
      },
    });
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusReason");
    // 400000 / 150000 ≈ 2.667
    expect((result.metadata?.collateralizationRatio as number | undefined)).toBeCloseTo(2.667, 2);
    expect((result.metadata?.totalCollateralRatio as number | undefined)).toBeCloseTo(2.667, 2);
    expectValidAdapterOutput("liquity-v1", result);
  });

  it("emits degraded warning when collateralization ratio falls below 1.2", async () => {
    // 100 ETH collateral at $1 → $100, debt = 100 LUSD → CR = 1.0
    mockSystemReads({ collateral: 100n * WAD, debt: 100n * WAD, price: WAD });
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 1]]));

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "liquity-v1-low-collateralization-ratio",
        severity: "warning",
      }),
    );
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0, 3);
  });

  it("keeps the protocol redemption gate readable when the ETH price is unavailable", async () => {
    mockSystemReads({ collateral: 100n * WAD, debt: 100n * WAD });
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(null);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map());

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "liquity-v1-eth-price-unavailable" }),
    ]);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open" });
  });

  it("pauses the route when the protocol-priced TCR is below MCR", async () => {
    // Protocol feed prices ETH at $1000 → TCR 0.5, while the market proxy at
    // $3000 would still show a healthy 1.5 collateralization ratio.
    mockSystemReads({ collateral: 100n * WAD, debt: 200_000n * WAD, price: 1_000n * WAD });
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 3000]]));

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.5, 3);
    expect(result.metadata?.totalCollateralRatio).toBeCloseTo(0.5, 3);
    expectValidAdapterOutput("liquity-v1", result);
    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: expect.stringContaining("below MCR"),
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "redemption-route-status-degraded", effect: "degraded" }),
    ]);
  });

  it("publishes an unknown route when the redemption gate is unreadable", async () => {
    mockSystemReads({ tcrReadable: false });
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 2000]]));

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.slices).toHaveLength(1);
    expect(result.metadata?.totalCollateralRatio).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "unknown",
      routeStatusReason: expect.stringContaining("Could not read the Liquity V1 redemption gate"),
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "redemption-route-status-unreadable", effect: "degraded" }),
    ]);
  });

  it("publishes an unknown route when the protocol price feed is unreadable", async () => {
    mockSystemReads({ price: null });
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 2000]]));

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.metadata?.details).toMatchObject({ protocolPriceRaw: null, tcrRaw: null });
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "unknown" });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "redemption-route-status-unreadable" }),
    ]);
  });

  it("fails closed when system collateral is unreadable", async () => {
    mockSystemReads({ collateral: null });
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 2000]]));

    await expect(fetchLiquityV1Reserves(coin, config, signal)).rejects.toThrow(
      "liquity-v1 getEntireSystemColl() returned zero/unreadable collateral",
    );
  });

  it("fails closed when system debt is zero", async () => {
    mockSystemReads({ debt: 0n });
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 2000]]));

    await expect(fetchLiquityV1Reserves(coin, config, signal)).rejects.toThrow(
      "liquity-v1 getEntireSystemDebt() returned zero/unreadable debt",
    );
  });

  it("fails closed when the batched TroveManager read is unavailable", async () => {
    mockSystemReads();
    vi.mocked(fetchOnchainMulticall3).mockResolvedValueOnce(null);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 2000]]));

    await expect(fetchLiquityV1Reserves(coin, config, signal)).rejects.toThrow(
      "liquity-v1 TroveManager batch returned no results",
    );
  });
});
