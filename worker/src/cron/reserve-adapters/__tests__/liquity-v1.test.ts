import { describe, expect, it } from "vitest";
import { runAdapter, type AdapterNetworkSpec, type AdapterRpcValue } from "./reserve-adapter.test-support";

const TROVE_MANAGER = "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2";
const PRICE_FEED = "0x4c517D4e2C851CA76d7eC94B805269Df0f2201De";
const COLLATERAL_SELECTOR = "0x887105d3";
const DEBT_SELECTOR = "0x795d26c3";
const MCR_SELECTOR = "0x794e5724";
const GET_TCR_SELECTOR = "0xb82f263d";
const FETCH_PRICE_SELECTOR = "0x0fdb11cf";
const REDEMPTION_RATE_SELECTOR = "0xc52861f2";
const WAD = 10n ** 18n;
const MCR_RAW = 11n * WAD / 10n;
const WETH_ETHEREUM_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETH_PRICE_URL = `https://coins.llama.fi/prices/current/ethereum:${WETH_ETHEREUM_ADDRESS.toLowerCase()}`;
const NOW_SEC = 1_800_000_000;

interface SystemState {
  collateral: bigint | null;
  debt: bigint | null;
  price: bigint | null;
  mcr: bigint | null;
  tcrReadable: boolean;
}

const DEFAULT_STATE: SystemState = {
  collateral: 200n * WAD,
  debt: 150_000n * WAD,
  price: 2_000n * WAD,
  mcr: MCR_RAW,
  tcrReadable: true,
};

function v1Network(
  overrides: Partial<SystemState> = {},
  ethPrice: number | null = 2_000,
  rateBps: number | null = 50,
): AdapterNetworkSpec {
  const state = { ...DEFAULT_STATE, ...overrides };
  const rateRaw = rateBps == null ? null : BigInt(rateBps) * WAD / 10_000n;
  const rpc: Record<string, AdapterRpcValue> = {
    [`ethereum:${PRICE_FEED}:${FETCH_PRICE_SELECTOR}`]: state.price,
    [`ethereum:${TROVE_MANAGER}:${COLLATERAL_SELECTOR}`]: state.collateral,
    [`ethereum:${TROVE_MANAGER}:${DEBT_SELECTOR}`]: state.debt,
    [`ethereum:${TROVE_MANAGER}:${MCR_SELECTOR}`]: state.mcr,
    [`ethereum:${TROVE_MANAGER}:${GET_TCR_SELECTOR}`]: (call) => {
      if (!state.tcrReadable || state.collateral == null || state.debt == null || state.debt === 0n) return null;
      const priceArg = BigInt(`0x${call.data.slice(GET_TCR_SELECTOR.length)}`);
      return (state.collateral * priceArg) / state.debt;
    },
    [`ethereum:${TROVE_MANAGER}:${REDEMPTION_RATE_SELECTOR}`]: rateRaw,
  };
  return {
    rpc,
    json: {
      [ETH_PRICE_URL]: ethPrice == null
        ? { coins: {} }
        : {
            coins: {
              [`ethereum:${WETH_ETHEREUM_ADDRESS.toLowerCase()}`]: {
                price: ethPrice,
                timestamp: NOW_SEC,
                confidence: 1,
              },
            },
          },
    },
  };
}

function runV1(network: AdapterNetworkSpec = v1Network()) {
  return runAdapter("liquity-v1", "lusd-liquity", { network, nowSec: NOW_SEC });
}

describe("fetchLiquityV1Reserves", () => {
  it("returns a 100% ETH slice with collateralization ratio from Liquity v1 reads", async () => {
    const { result } = await runV1();

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
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(2.667, 2);
    expect(result.metadata?.totalCollateralRatio).toBeCloseTo(2.667, 2);
  });

  it("emits degraded warning when collateralization ratio falls below 1.2", async () => {
    const { result } = await runV1(v1Network({ collateral: 100n * WAD, debt: 100n * WAD, price: WAD }, 1));
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "liquity-v1-low-collateralization-ratio", severity: "warning" }),
    );
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0, 3);
  });

  it("keeps the protocol redemption gate readable when the ETH price is unavailable", async () => {
    const { result } = await runV1(
      v1Network({ collateral: 100n * WAD, debt: 100n * WAD }, null, null),
    );
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "liquity-v1-eth-price-unavailable" }),
    ]);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open" });
  });

  it("pauses the route when the protocol-priced TCR is below MCR", async () => {
    const { result } = await runV1(
      v1Network({ collateral: 100n * WAD, debt: 200_000n * WAD, price: 1_000n * WAD }, 3_000),
    );
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.5, 3);
    expect(result.metadata?.totalCollateralRatio).toBeCloseTo(0.5, 3);
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
    const { result } = await runV1(v1Network({ tcrReadable: false }));
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
    const { result } = await runV1(v1Network({ price: null }));
    expect(result.metadata?.details).toMatchObject({ protocolPriceRaw: null, tcrRaw: null });
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "unknown" });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "redemption-route-status-unreadable" }),
    ]);
  });

  it("fails closed when system collateral is unreadable", async () => {
    await expect(runV1(v1Network({ collateral: null }))).rejects.toThrow(
      "liquity-v1 getEntireSystemColl() returned zero/unreadable collateral",
    );
  });

  it("fails closed when system debt is zero", async () => {
    await expect(runV1(v1Network({ debt: 0n }))).rejects.toThrow(
      "liquity-v1 getEntireSystemDebt() returned zero/unreadable debt",
    );
  });

  it("fails closed when the batched TroveManager read is unavailable", async () => {
    const network = { ...v1Network(), multicall: false };
    await expect(runV1(network)).rejects.toThrow();
  });
});
