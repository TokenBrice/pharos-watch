import { describe, expect, it } from "vitest";
import { encodeFunctionResult, parseAbi, toFunctionSelector } from "viem/utils";
import { installAdapterNetwork, runAdapter, type AdapterNetwork } from "./reserve-adapter.test-support";
import {
  adaptYamatoStates,
  decodeYamatoGetStates,
} from "../yamato";

const ETHEREUM_RPC = "https://ethereum-rpc.publicnode.com";
const BLOCK = { number: 12_345, timestamp: 1_776_154_391 };
const NOW_SEC = BLOCK.timestamp + 30;
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETH_PRICE_KEY = `ethereum:${WETH_ADDRESS.toLowerCase()}`;
const ETH_PRICE_URL = `https://coins.llama.fi/prices/current/${ETH_PRICE_KEY}`;
const YAMATO_GET_STATES_SELECTOR = toFunctionSelector("getStates()");
const YAMATO_PRICE_FEED_SELECTOR = toFunctionSelector("priceFeed()");
const YAMATO_GET_PRICE_SELECTOR = toFunctionSelector("getPrice()");
const YAMATO_PAUSED_SELECTOR = toFunctionSelector("paused()");
const YAMATO_PRIORITY_REGISTRY_SELECTOR = toFunctionSelector("priorityRegistry()");
const PRIORITY_REGISTRY_YAMATO_SELECTOR = toFunctionSelector("yamato()");
const PRIORITY_REGISTRY_GET_REDEEMABLES_CAP_SELECTOR = toFunctionSelector("getRedeemablesCap()");
const YAMATO_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const PRICE_FEED_ADDRESS = "0x2222222222222222222222222222222222222222" as const;
const PRIORITY_REGISTRY_ADDRESS = "0x3333333333333333333333333333333333333333" as const;
const ONE = 10n ** 18n;

const YAMATO_TEST_ABI = parseAbi([
  "function getStates() view returns (uint256 totalColl, uint256 totalDebt, uint8 MCR, uint8 RRR, uint8 SRR, uint8 GRR)",
  "function priceFeed() view returns (address)",
]);
const PRICE_FEED_TEST_ABI = parseAbi(["function getPrice() view returns (uint256)"]);
const REDEMPTION_TEST_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function priorityRegistry() view returns (address)",
  "function yamato() view returns (address)",
  "function getRedeemablesCap() view returns (uint256)",
]);

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

function encodePaused(paused: boolean): `0x${string}` {
  return encodeFunctionResult({ abi: REDEMPTION_TEST_ABI, functionName: "paused", result: paused });
}

function encodeAddress(
  functionName: "priorityRegistry" | "yamato",
  address: `0x${string}`,
): `0x${string}` {
  return encodeFunctionResult({ abi: REDEMPTION_TEST_ABI, functionName, result: address });
}

function encodeRedeemablesCap(capRaw: bigint): `0x${string}` {
  return encodeFunctionResult({ abi: REDEMPTION_TEST_ABI, functionName: "getRedeemablesCap", result: capRaw });
}
type YamatoResponse = `0x${string}` | null;
type NetworkOptions = {
  responses?: Record<string, YamatoResponse>;
  ethPrice?: number | null;
};

function installYamatoNetwork(options: NetworkOptions = {}): AdapterNetwork {
  const responses: Record<string, YamatoResponse> = {
    [YAMATO_GET_STATES_SELECTOR]: encodeStates(),
    [YAMATO_PRICE_FEED_SELECTOR]: encodePriceFeedAddress(),
    [YAMATO_GET_PRICE_SELECTOR]: encodeEthJpyPrice(),
    [YAMATO_PAUSED_SELECTOR]: encodePaused(false),
    [YAMATO_PRIORITY_REGISTRY_SELECTOR]: encodeAddress("priorityRegistry", PRIORITY_REGISTRY_ADDRESS),
    [PRIORITY_REGISTRY_YAMATO_SELECTOR]: encodeAddress("yamato", YAMATO_ADDRESS),
    [PRIORITY_REGISTRY_GET_REDEEMABLES_CAP_SELECTOR]: encodeRedeemablesCap(0n),
    ...options.responses,
  };
  const quote = options.ethPrice === null
    ? {}
    : {
        [ETH_PRICE_KEY]: {
          price: options.ethPrice ?? 3_000,
          timestamp: NOW_SEC,
          confidence: 1,
        },
      };
  return installAdapterNetwork({
    chains: { ethereum: ETHEREUM_RPC },
    block: BLOCK,
    rpc: {
      [`ethereum:${YAMATO_ADDRESS}:${YAMATO_GET_STATES_SELECTOR}`]: responses[YAMATO_GET_STATES_SELECTOR],
      [`ethereum:${YAMATO_ADDRESS}:${YAMATO_PRICE_FEED_SELECTOR}`]: responses[YAMATO_PRICE_FEED_SELECTOR],
      [`ethereum:${PRICE_FEED_ADDRESS}:${YAMATO_GET_PRICE_SELECTOR}`]: responses[YAMATO_GET_PRICE_SELECTOR],
      [`ethereum:${YAMATO_ADDRESS}:${YAMATO_PAUSED_SELECTOR}`]: responses[YAMATO_PAUSED_SELECTOR],
      [`ethereum:${YAMATO_ADDRESS}:${YAMATO_PRIORITY_REGISTRY_SELECTOR}`]: responses[YAMATO_PRIORITY_REGISTRY_SELECTOR],
      [`ethereum:${PRIORITY_REGISTRY_ADDRESS}:${PRIORITY_REGISTRY_YAMATO_SELECTOR}`]: responses[PRIORITY_REGISTRY_YAMATO_SELECTOR],
      [`ethereum:${PRIORITY_REGISTRY_ADDRESS}:${PRIORITY_REGISTRY_GET_REDEEMABLES_CAP_SELECTOR}`]:
        responses[PRIORITY_REGISTRY_GET_REDEEMABLES_CAP_SELECTOR],
    },
    json: { [ETH_PRICE_URL]: { coins: quote } },
  });
}

async function fetchFixture(
  network = installYamatoNetwork(),
  params: Record<string, unknown> = {},
) {
  const { result } = await runAdapter("yamato", "cjpy-yamato", {
    network,
    nowSec: NOW_SEC,
    params: { yamatoAddress: YAMATO_ADDRESS, ...params },
  });
  return result;
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

    expect(result.slices).toEqual([{ sourceKey: "yamato:eth", name: "ETH", pct: 100, risk: "very-low" }]);
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
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: [
          "https://docs.yamato.fi/v/en",
          "https://github.com/DeFiGeek-Community/yamato",
        ],
      },
    });
    // No same-run paused() probe means the route status is withheld, not assumed open.
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatus");
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
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
        redemption: {
          paused: false,
          priorityRegistryAddress: PRIORITY_REGISTRY_ADDRESS,
          redeemableCapJpyRaw: 0n,
        },
      },
    );

    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "degraded",
      routeStatusSource: "onchain",
      routeStatusReason: expect.stringContaining("below MCR"),
    });
  });

  it("withholds route status when the redemption probe is null", () => {
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
        ethJpyPriceRaw: 400_000n * ONE,
      },
    );

    expect(result.metadata?.redemption).toBeDefined();
    expect(result.metadata?.redemption).toMatchObject({
      freshnessKind: "same-run-onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
    });
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatus");
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusReason");
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

    expect(result.slices).toEqual([{ sourceKey: "yamato:eth", name: "ETH", pct: 100, risk: "very-low", depType: "collateral" }]);
  });

  it("floors the redeemable cap at the collateral getStates() actually measured", () => {
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
        ethJpyPriceRaw: 400_000n * ONE,
        ethPriceUsd: 3_000,
        redemption: {
          paused: false,
          priorityRegistryAddress: PRIORITY_REGISTRY_ADDRESS,
          // 60m JPY is 150 ETH at the oracle price, above the 100 ETH held.
          redeemableCapJpyRaw: 60_000_000n * ONE,
        },
      },
    );

    expect(result.metadata).toMatchObject({
      redeemableCapEth: 100,
      redemption: { capacityUsd: 300_000 },
    });
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
  it("rejects a malformed slice instead of silently defaulting it", async () => {
    await expect(fetchFixture(installYamatoNetwork(), { slice: { name: "ETH" } }))
      .rejects.toThrow("yamato adapter params invalid");
  });

  it("reads getStates(), resolves the price feed, and adapts same-run on-chain state", async () => {
    const result = await fetchFixture();

    expect(result.metadata?.observedBlock).toEqual({ chain: "ethereum", number: BLOCK.number, timestamp: BLOCK.timestamp });
    expect(result.slices).toEqual([{ sourceKey: "yamato:eth", name: "ETH", pct: 100, risk: "very-low" }]);
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
    const network = installYamatoNetwork();
    const result = await fetchFixture(network, { priceFeedAddress: PRICE_FEED_ADDRESS });

    expect(network.rpcCalls.some(
      (call) => call.contract === YAMATO_ADDRESS.toLowerCase() && call.selector === YAMATO_PRICE_FEED_SELECTOR,
    )).toBe(false);
    expect(result.metadata?.priceFeedAddress).toBe(PRICE_FEED_ADDRESS);
  });

  it("fails when getStates() is unreadable", async () => {
    const network = installYamatoNetwork({ responses: { [YAMATO_GET_STATES_SELECTOR]: null } });

    await expect(fetchFixture(network)).rejects.toThrow("yamato getStates() call failed");
  });

  it("publishes an open redemption route priced from the same-run redeemables cap", async () => {
    const network = installYamatoNetwork({
      responses: { [PRIORITY_REGISTRY_GET_REDEEMABLES_CAP_SELECTOR]: encodeRedeemablesCap(6_500_000n * ONE) },
    });
    const result = await fetchFixture(network);

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      priorityRegistryAddress: PRIORITY_REGISTRY_ADDRESS.toLowerCase(),
      redeemableCapJpy: 6_500_000,
      redeemableCapEth: 16.25,
      ethPriceUsd: 3_000,
      redemption: {
        capacityUsd: 48_750,
        capacityKind: "live-direct-bounded",
        capacityRatioOfSupply: 0.325,
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
    });
  });

  it("publishes a zero capacity without pricing ETH when no pledge is redeemable", async () => {
    const network = installYamatoNetwork();
    const result = await fetchFixture(network);

    expect(network.requests.some(({ url }) => url.replace(/\/$/, "") === ETH_PRICE_URL)).toBe(false);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      capacityKind: "live-direct-bounded",
      capacityRatioOfSupply: 0,
      routeStatus: "open",
    });
  });

  it("withholds capacity when the priority registry does not bind back to the Yamato proxy", async () => {
    const network = installYamatoNetwork({
      responses: {
        [PRIORITY_REGISTRY_YAMATO_SELECTOR]: encodeAddress("yamato", PRICE_FEED_ADDRESS),
        [PRIORITY_REGISTRY_GET_REDEEMABLES_CAP_SELECTOR]: encodeRedeemablesCap(6_500_000n * ONE),
      },
    });
    const result = await fetchFixture(network);

    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.metadata).not.toHaveProperty("redeemableCapJpy");
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatus");
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "yamato-redeemables-cap-unreadable" }),
    ]);
  });

  it("withholds capacity when ETH/USD is unavailable for a non-zero cap", async () => {
    const network = installYamatoNetwork({
      ethPrice: null,
      responses: { [PRIORITY_REGISTRY_GET_REDEEMABLES_CAP_SELECTOR]: encodeRedeemablesCap(6_500_000n * ONE) },
    });
    const result = await fetchFixture(network);

    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.metadata?.redemption).toMatchObject({ capacityRatioOfSupply: 0.325 });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "yamato-eth-price-unavailable" }),
    ]);
  });

  it("reports the route as paused when Yamato paused() is true", async () => {
    const network = installYamatoNetwork({ responses: { [YAMATO_PAUSED_SELECTOR]: encodePaused(true) } });
    const result = await fetchFixture(network);

    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: expect.stringContaining("whenNotPaused"),
    });
  });
});
