import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeFunctionResult, parseAbi } from "viem/utils";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchOnchainRawCall,
    makeOnchainCallers: vi.fn((input, options) => ({
      uint256: vi.fn(),
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

import { fetchOnchainRawCall } from "../helpers";
import {
  adaptYamatoStates,
  decodeYamatoGetStates,
  fetchYamatoReserves,
  YAMATO_GET_PRICE_SELECTOR,
  YAMATO_GET_STATES_SELECTOR,
  YAMATO_PRICE_FEED_SELECTOR,
} from "../yamato";

const signal = AbortSignal.timeout(5_000);
const coin = { id: "cjpy-yamato" } as StablecoinMeta;
const YAMATO_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const PRICE_FEED_ADDRESS = "0x2222222222222222222222222222222222222222" as const;
const ONE = 10n ** 18n;

const YAMATO_TEST_ABI = parseAbi([
  "function getStates() view returns (uint256 totalColl, uint256 totalDebt, uint8 MCR, uint8 RRR, uint8 SRR, uint8 GRR)",
  "function priceFeed() view returns (address)",
]);
const PRICE_FEED_TEST_ABI = parseAbi(["function getPrice() view returns (uint256)"]);

function encodeStates(
  input: {
    totalColl?: bigint;
    totalDebt?: bigint;
    mcr?: number;
    rrr?: number;
    srr?: number;
    grr?: number;
  } = {},
): `0x${string}` {
  return encodeFunctionResult({
    abi: YAMATO_TEST_ABI,
    functionName: "getStates",
    result: [
      input.totalColl ?? 100n * ONE,
      input.totalDebt ?? 20_000_000n * ONE,
      input.mcr ?? 130,
      input.rrr ?? 80,
      input.srr ?? 20,
      input.grr ?? 1,
    ],
  });
}

function encodePriceFeedAddress(address: `0x${string}` = PRICE_FEED_ADDRESS): `0x${string}` {
  return encodeFunctionResult({
    abi: YAMATO_TEST_ABI,
    functionName: "priceFeed",
    result: address,
  });
}

function encodeEthJpyPrice(priceRaw = 400_000n * ONE): `0x${string}` {
  return encodeFunctionResult({
    abi: PRICE_FEED_TEST_ABI,
    functionName: "getPrice",
    result: priceRaw,
  });
}

function makeConfig(params: Record<string, unknown> = { yamatoAddress: YAMATO_ADDRESS }): LiveReservesConfig {
  return {
    adapter: "yamato",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "alchemy" },
    },
    params,
  } as unknown as LiveReservesConfig;
}

describe("decodeYamatoGetStates", () => {
  it("decodes Yamato getStates() output into raw collateral, debt, and thresholds", () => {
    expect(decodeYamatoGetStates(encodeStates())).toEqual({
      totalCollateralRaw: 100n * ONE,
      totalDebtRaw: 20_000_000n * ONE,
      mcrPct: 130,
      rrrPct: 80,
      srrPct: 20,
      grrPct: 1,
    });
  });

  it("rejects malformed raw call data", () => {
    expect(() => decodeYamatoGetStates("0x1234")).toThrow();
  });
});

describe("adaptYamatoStates", () => {
  it("models Yamato as one ETH reserve slice with JPY debt and CR metadata", () => {
    const result = adaptYamatoStates(
      {
        totalCollateralRaw: 100n * ONE,
        totalDebtRaw: 20_000_000n * ONE,
        mcrPct: 130,
        rrrPct: 80,
        srrPct: 20,
        grrPct: 1,
      },
      {
        yamatoAddress: YAMATO_ADDRESS,
        priceFeedAddress: PRICE_FEED_ADDRESS,
        ethJpyPriceRaw: 400_000n * ONE,
      },
    );

    expect(result.slices).toEqual([{ name: "ETH", pct: 100, risk: "very-low" }]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: {
        proofKind: "yamato-get-states",
        freshnessReason: "same-run-onchain-state",
      },
      yamatoAddress: YAMATO_ADDRESS,
      priceFeedAddress: PRICE_FEED_ADDRESS,
      totalCollateralRaw: "100000000000000000000",
      totalDebtRaw: "20000000000000000000000000",
      totalCollateralEth: 100,
      totalDebtJpy: 20_000_000,
      ethJpyPriceRaw: "400000000000000000000000",
      ethJpyPrice: 400_000,
      totalCollateralJpy: 40_000_000,
      collateralizationRatio: 2,
      collateralizationRatioPct: 200,
      collateralizationRatioPerTenThousand: 20_000,
      mcrRaw: 130,
      rrrRaw: 80,
      srrRaw: 20,
      grrRaw: 1,
      minimumCollateralRatio: 1.3,
      minimumCollateralRatioPct: 130,
      minimumCollateralRatioPerTenThousand: 13_000,
      redemptionReserveRatePct: 80,
      sweepReserveRatePct: 20,
      gasReserveRatePct: 1,
      redemption: {
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: [
          "https://docs.yamato.fi/v/en",
          "https://github.com/DeFiGeek-Community/yamato",
        ],
      },
    });
  });

  it("degrades redemption route metadata when system CR is below MCR", () => {
    const result = adaptYamatoStates(
      {
        totalCollateralRaw: 1n * ONE,
        totalDebtRaw: 100_000n * ONE,
        mcrPct: 130,
        rrrPct: 80,
        srrPct: 20,
        grrPct: 1,
      },
      {
        ethJpyPriceRaw: 100_000n * ONE,
      },
    );

    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "degraded",
      routeStatusSource: "onchain",
      routeStatusReason: expect.stringContaining("below MCR"),
    });
  });

  it("allows the ETH slice metadata to be supplied by adapter params", () => {
    const result = adaptYamatoStates(
      {
        totalCollateralRaw: 1n * ONE,
        totalDebtRaw: 100_000n * ONE,
        mcrPct: 130,
        rrrPct: 80,
        srrPct: 20,
        grrPct: 1,
      },
      {
        ethJpyPriceRaw: 200_000n * ONE,
        slice: {
          name: "ETH",
          risk: "very-low",
          depType: "collateral",
        },
      },
    );

    expect(result.slices).toEqual([{ name: "ETH", pct: 100, risk: "very-low", depType: "collateral" }]);
  });

  it("fails closed when getStates() reports zero collateral or debt", () => {
    expect(() =>
      adaptYamatoStates({
        totalCollateralRaw: 0n,
        totalDebtRaw: 1n * ONE,
        mcrPct: 130,
        rrrPct: 80,
        srrPct: 20,
        grrPct: 1,
      }),
    ).toThrow("yamato getStates() returned zero collateral");

    expect(() =>
      adaptYamatoStates({
        totalCollateralRaw: 1n * ONE,
        totalDebtRaw: 0n,
        mcrPct: 130,
        rrrPct: 80,
        srrPct: 20,
        grrPct: 1,
      }),
    ).toThrow("yamato getStates() returned zero debt");
  });
});

describe("fetchYamatoReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads getStates(), resolves the price feed, and adapts same-run on-chain state", async () => {
    vi.mocked(fetchOnchainRawCall)
      .mockResolvedValueOnce(encodeStates())
      .mockResolvedValueOnce(encodePriceFeedAddress())
      .mockResolvedValueOnce(encodeEthJpyPrice());

    const result = await fetchYamatoReserves(coin, makeConfig(), signal);

    expect(fetchOnchainRawCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        contract: YAMATO_ADDRESS,
        data: YAMATO_GET_STATES_SELECTOR,
        chain: "ethereum",
        rpcMode: "alchemy",
      }),
    );
    expect(fetchOnchainRawCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        contract: YAMATO_ADDRESS,
        data: YAMATO_PRICE_FEED_SELECTOR,
        chain: "ethereum",
        rpcMode: "alchemy",
      }),
    );
    expect(fetchOnchainRawCall).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        contract: PRICE_FEED_ADDRESS.toLowerCase(),
        data: YAMATO_GET_PRICE_SELECTOR,
        chain: "ethereum",
        rpcMode: "alchemy",
      }),
    );
    expect(result.slices).toEqual([{ name: "ETH", pct: 100, risk: "very-low" }]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalCollateralEth: 100,
      totalDebtJpy: 20_000_000,
      ethJpyPrice: 400_000,
      collateralizationRatio: 2,
      minimumCollateralRatioPct: 130,
    });
  });

  it("uses a configured price feed address without calling priceFeed()", async () => {
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeStates()).mockResolvedValueOnce(encodeEthJpyPrice());

    const result = await fetchYamatoReserves(
      coin,
      makeConfig({ yamatoAddress: YAMATO_ADDRESS, priceFeedAddress: PRICE_FEED_ADDRESS }),
      signal,
    );

    expect(fetchOnchainRawCall).toHaveBeenCalledTimes(2);
    expect(fetchOnchainRawCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        contract: PRICE_FEED_ADDRESS,
        data: YAMATO_GET_PRICE_SELECTOR,
      }),
    );
    expect(result.metadata?.priceFeedAddress).toBe(PRICE_FEED_ADDRESS);
  });

  it("fails when getStates() is unreadable", async () => {
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(null).mockResolvedValueOnce(encodePriceFeedAddress());

    await expect(fetchYamatoReserves(coin, makeConfig(), signal)).rejects.toThrow("yamato getStates() call failed");
  });
});
