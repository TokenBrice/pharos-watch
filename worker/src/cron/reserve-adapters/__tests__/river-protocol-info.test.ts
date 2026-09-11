import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptRiverProtocolInfo } from "../river-protocol-info";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";
import {
  expectValidAdapterOutput,
  runAdapter,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";

afterEach(() => vi.unstubAllGlobals());

// The real catalog endpoint for satusd-river.
const RIVER_ENDPOINT = "https://api.riverai.inc/protocol-info";
const SATOSHI_APP_BY_CHAIN: Record<string, string> = {
  ethereum: "0xb8374e4dff99202292da2fe34425e1de665b67e6",
  base: "0x9a3c724ee9603a7550499be73dc743b371811dd3",
};
const SATUSD_BY_CHAIN: Record<string, string> = {
  ethereum: "0x1958853a8be062dc4f401750eb233f5850f0d0d2",
  base: "0x70654aad8b7734dc319d0c3608ec7b32e03fa162",
};
const BOB_SATUSD = "0xecf21b335b41f9d5a89f6186a99c19a3c467871f";
const TROVE_MANAGER_BY_CHAIN: Record<string, string[]> = {
  ethereum: ["0xb97e6219b0836e21ae671358e746f03dcdbcb6d8", "0xc03403dd8f27cefa314fc109d26777c81b0de895"],
  base: ["0xddac7d4e228c205197fe9961865ffe20173de56b"],
};
const ONE = 10n ** 18n;
const REDEMPTION_FEE_FLOOR = ONE / 200n; // 0.5%
const NOW_SEC = 1_776_290_400 + 3_600;

const DEBT_TOKEN_SELECTOR = "0xf8d89898";
const GLOBAL_SYSTEM_BALANCES_SELECTOR = "0x716c53c2";
const GET_TCR_SELECTOR = "0xb620115d";
const TROVE_MANAGER_COUNT_SELECTOR = "0x679df0d9";
const TROVE_MANAGERS_SELECTOR = "0x3b707478";
const REDEMPTION_RATE_WITH_DECAY_SELECTOR = "0xc52861f2";
const MCR_SELECTOR = "0x794e5724";
const SUNSETTING_SELECTOR = "0x9484fb8e";

const abiWord = (value: bigint) => value.toString(16).padStart(64, "0");

const RIVER_PAYLOAD = {
  tvl: 250_000_000,
  circulatingSupply: 159_000_000,
  tvlData: [{ timestamp: 1_776_290_400, value: 250_000_000 }],
  circulatingData: [{ timestamp: 1_776_290_400, value: 159_000_000 }],
};

interface RiverChainState {
  debtToken?: string;
  totalDebt: bigint;
  tcr: bigint;
  troveManagers: string[];
  branchDebtToken?: string;
  rates: bigint[];
  mcrs: bigint[];
  sunsetting: boolean[];
  fail?: boolean;
}

function defaultChainState(chain: string): RiverChainState {
  const troveManagers = TROVE_MANAGER_BY_CHAIN[chain] ?? [];
  return {
    totalDebt: chain === "ethereum" ? 100_000n * ONE : 9_000_000n * ONE,
    tcr: 3n * ONE,
    troveManagers,
    rates: troveManagers.map(() => REDEMPTION_FEE_FLOOR),
    mcrs: troveManagers.map(() => (11n * ONE) / 10n),
    sunsetting: troveManagers.map(() => false),
  };
}

/**
 * Wire the protocol-info JSON payload plus the same-run Satoshi app and branch
 * reads per chain. `fail` reverts the chain's app `debtToken()` so the whole
 * chain drops, exactly like an unreachable RPC would.
 */
function riverNetwork(
  chains: Record<string, Partial<RiverChainState>>,
  payload: object = RIVER_PAYLOAD,
): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {};
  // Both pinned chains are primed with defaults; per-test entries override.
  const chainStates: Record<string, Partial<RiverChainState>> = { ethereum: {}, base: {}, ...chains };
  for (const [chain, overrides] of Object.entries(chainStates)) {
    const state: RiverChainState = { ...defaultChainState(chain), ...overrides };
    const app = SATOSHI_APP_BY_CHAIN[chain];
    const satUsd = SATUSD_BY_CHAIN[chain];
    rpc[`${app}:${DEBT_TOKEN_SELECTOR}`] = state.fail ? null : state.debtToken ?? satUsd;
    rpc[`${app}:${GLOBAL_SYSTEM_BALANCES_SELECTOR}`] = `0x${abiWord(ONE)}${abiWord(state.totalDebt)}`;
    rpc[`${app}:${GET_TCR_SELECTOR}`] = state.tcr;
    rpc[`${app}:${TROVE_MANAGER_COUNT_SELECTOR}`] = BigInt(state.troveManagers.length);
    // troveManagers(uint256): unused slots above the reported count revert as
    // failed optional members; anything past the speculative window is a tripwire.
    rpc[`${app}:${TROVE_MANAGERS_SELECTOR}`] = ({ data }) => {
      const index = Number(BigInt(`0x${data.slice(10)}`));
      if (index >= 12) throw new Error(`Unexpected manager slot ${index}`);
      return state.troveManagers[index] ?? null;
    };
    state.troveManagers.forEach((manager, index) => {
      rpc[`${manager}:${DEBT_TOKEN_SELECTOR}`] = state.branchDebtToken ?? satUsd;
      rpc[`${manager}:${REDEMPTION_RATE_WITH_DECAY_SELECTOR}`] = state.rates[index];
      rpc[`${manager}:${MCR_SELECTOR}`] = state.mcrs[index];
      rpc[`${manager}:${SUNSETTING_SELECTOR}`] = state.sunsetting[index];
    });
  }
  return { json: { [RIVER_ENDPOINT]: payload }, rpc };
}

/** Real catalog coin, restricted to the ethereum/base/bob contracts under test. */
function runRiver(network: AdapterNetworkSpec, options: { signal?: AbortSignal } = {}) {
  return runAdapter("river-protocol-info", "satusd-river", {
    network,
    nowSec: NOW_SEC,
    coin: {
      contracts: [
        { chain: "ethereum", address: SATUSD_BY_CHAIN.ethereum, decimals: 18 },
        { chain: "base", address: SATUSD_BY_CHAIN.base, decimals: 18 },
        // Not in the pinned Satoshi app registry — must never be probed.
        { chain: "bob", address: BOB_SATUSD, decimals: 18 },
      ],
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

describe("adaptRiverProtocolInfo", () => {
  it("maps aggregate River TVL telemetry as proof-class collateral context", () => {
    const result = adaptRiverProtocolInfo({
      tvl: 300_000_000,
      circulatingSupply: 150_000_000,
      chainCirculating: [{ chain: "Base", circulating: 100_000_000 }],
      tvlData: [{ chainId: 8453, timestamp: "1776290400", value: 120_000_000 }],
      circulatingData: [{ chainId: 8453, timestamp: "1776290400", value: 30_000_000 }],
    });

    expect(result.slices).toEqual([
      { name: "Aggregate River protocol collateral TVL", pct: 100, risk: "medium" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1776290400,
      totalReserveUsd: 300_000_000,
      supplyUsd: 150_000_000,
      chainCirculatingCount: 1,
      tvlPointCount: 1,
      circulatingPointCount: 1,
      details: {
        protocolTvlToSupplyRatio: 2,
      },
    });
  });

  it("uses the oldest material point for snapshot timestamp and keeps spread provenance", () => {
    const result = adaptRiverProtocolInfo({
      tvl: 300_000_000,
      circulatingSupply: 150_000_000,
      tvlData: [
        { timestamp: 1_775_000_000, value: 1000 },
        { timestamp: 1_776_000_000, value: 2000 },
      ],
      circulatingData: [
        { timestamp: 1_775_500_000, value: 500 },
        { timestamp: 1_776_500_000, value: 1500 },
      ],
    });

    expect(result.metadata?.sourceTimestamp).toBe(1_775_000_000);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.latestSourceTimestamp).toBe(1_776_500_000);
    expect(result.metadata?.sourceTimestampSpreadSec).toBe(1_500_000);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "source-timestamp-spread",
        effect: "degraded",
      }),
    ]));
  });

  it("publishes a sub-1 TVL-to-supply diagnostic without a coverage shortfall warning", () => {
    const result = adaptRiverProtocolInfo({
      tvl: 640,
      circulatingSupply: 1000,
    });

    expect(result.metadata?.details).toMatchObject({ protocolTvlToSupplyRatio: 0.64 });
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    // Protocol-wide TVL is not satUSD backing, so a sub-1 ratio must not be
    // presented as a reserve-undercollateralized state (R1).
    expect(result.warnings ?? []).toEqual([]);
  });

  it("throws when TVL or circulatingSupply is missing (parse-failure path)", () => {
    expect(() => adaptRiverProtocolInfo({ circulatingSupply: 100 })).toThrow(
      "river-protocol-info missing TVL or circulating supply",
    );
    expect(() => adaptRiverProtocolInfo({ tvl: 100 })).toThrow(
      "river-protocol-info missing TVL or circulating supply",
    );
    expect(() => adaptRiverProtocolInfo({ tvl: 0, circulatingSupply: 100 })).toThrow();
  });

  it("falls back to unverified freshness when both time series are empty", () => {
    const result = adaptRiverProtocolInfo({
      tvl: 1000,
      circulatingSupply: 500,
      tvlData: [],
      circulatingData: [],
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });

  it("is rejected by validateAdapterOutput when the latest source timestamp is in the future", () => {
    const futureSec = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const result = adaptRiverProtocolInfo({
      tvl: 1000,
      circulatingSupply: 500,
      tvlData: [{ timestamp: futureSec, value: 1000 }],
      circulatingData: [{ timestamp: futureSec, value: 500 }],
    });
    const adapter = getReserveAdapter("river-protocol-info") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });
    expect(report.valid).toBe(false);
  });
});

describe("fetchRiverProtocolInfoReserves branch redemption telemetry", () => {
  it("ignores reverting unused manager slots while summing debt and bounding branch fees", async () => {
    const { result } = await runRiver(riverNetwork({ ethereum: {}, base: {} }));

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 9_100_000,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      holderEligibility: "any-holder",
      routeStatus: "open",
      routeStatusSource: "onchain",
      feeBps: 50,
    });
    expect(result.metadata?.details).toMatchObject({
      redeemRoute: {
        proofKind: "satoshi-protocol-branch-trove-debt",
        probedChains: ["ethereum", "base"],
      },
    });
    // Aggregate protocol TVL stays a separate, unrelated reserve figure.
    expect(result.metadata?.totalReserveUsd).toBe(250_000_000);
    expectValidAdapterOutput("river-protocol-info", result);
  });

  it("never probes a chain without a pinned Satoshi app", async () => {
    const { network } = await runRiver(riverNetwork({ ethereum: {}, base: {} }));

    const probed = [...new Set(network.rpcCalls.map((call) => call.contract))].sort();
    expect(probed).not.toContain(BOB_SATUSD);
    expect(probed).toEqual([
      SATOSHI_APP_BY_CHAIN.base,
      SATOSHI_APP_BY_CHAIN.ethereum,
      ...TROVE_MANAGER_BY_CHAIN.base,
      ...TROVE_MANAGER_BY_CHAIN.ethereum,
    ].sort());
  });

  it("drops a chain whose debtToken() no longer round-trips to the tracked satUSD", async () => {
    const { result } = await runRiver(riverNetwork({
      base: { debtToken: "0x1111111111111111111111111111111111111111" },
    }));

    expect(result.metadata?.redemption?.capacityUsd).toBe(100_000);
    expect(result.metadata?.details).toMatchObject({ redeemRoute: { droppedChains: ["base"] } });
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "river-redemption-partial-chain-coverage", effect: "info" }),
      ]),
    );
  });

  it("drops a chain with a mismatched branch debt token", async () => {
    const { result } = await runRiver(riverNetwork({
      base: { branchDebtToken: "0x1111111111111111111111111111111111111111" },
    }));

    expect(result.metadata?.redemption?.capacityUsd).toBe(100_000);
    expect(result.metadata?.details).toMatchObject({ redeemRoute: { droppedChains: ["base"] } });
  });

  it("drops a chain whose global TCR sits below its deepest branch MCR", async () => {
    // redeemCollateral() reverts with "Cannot redeem when TCR < MCR".
    const { result } = await runRiver(riverNetwork({
      base: { tcr: (12n * ONE) / 10n, mcrs: [(15n * ONE) / 10n] },
    }));

    expect(result.metadata?.redemption?.capacityUsd).toBe(100_000);
    expect(result.metadata?.details).toMatchObject({ redeemRoute: { droppedChains: ["base"] } });
  });

  it("drops a chain whose branch count outgrows the speculative enumeration window", async () => {
    const { result } = await runRiver(riverNetwork({
      base: { troveManagers: new Array(13).fill(TROVE_MANAGER_BY_CHAIN.base[0]) },
    }));

    expect(result.metadata?.details).toMatchObject({ redeemRoute: { droppedChains: ["base"] } });
  });

  it("keeps verified capacity but omits fees if any chain reports a rate above 100%", async () => {
    const { result } = await runRiver(riverNetwork({
      base: { rates: [ONE + 1n] },
    }));

    expect(result.metadata?.redemption?.capacityUsd).toBe(9_100_000);
    expect(result.metadata?.redemption?.feeBps).toBeUndefined();
  });

  it("accepts TCR exactly equal to the deepest MCR", async () => {
    const { result } = await runRiver(riverNetwork({
      base: { tcr: 3n * ONE, mcrs: [3n * ONE] },
    }));

    expect(result.metadata?.redemption?.capacityUsd).toBe(9_100_000);
  });

  it("carries the highest branch rate across chains rather than the floor", async () => {
    const { result } = await runRiver(riverNetwork({
      base: { rates: [ONE / 20n] }, // 5%
    }));

    expect(result.metadata?.redemption?.feeBps).toBe(500);
  });

  it("publishes the measured zero capacity without claiming the route is open", async () => {
    const { result } = await runRiver(riverNetwork({
      ethereum: { totalDebt: 0n },
      base: { totalDebt: 0n },
    }));

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, feeBps: 50 });
    expect(result.metadata?.redemption?.routeStatus).toBeUndefined();
    expectValidAdapterOutput("river-protocol-info", result);
  });

  it("withholds the whole redemption block when no chain verifies", async () => {
    const { result } = await runRiver(riverNetwork({
      ethereum: { fail: true },
      base: { fail: true },
    }));

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.details?.redeemRoute).toBeUndefined();
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "river-redemption-unreadable", effect: "info" }),
      ]),
    );
    expectValidAdapterOutput("river-protocol-info", result);
  });

  it("propagates RPC cancellation instead of emitting unreadable telemetry", async () => {
    const controller = new AbortController();
    const error = new DOMException("Cancelled", "AbortError");
    const spec = riverNetwork({ ethereum: {}, base: {} });
    spec.rpc![`${SATOSHI_APP_BY_CHAIN.ethereum}:${DEBT_TOKEN_SELECTOR}`] = () => {
      controller.abort(error);
      throw error;
    };

    await expect(runRiver(spec, { signal: controller.signal })).rejects.toBe(error);
  });
});
