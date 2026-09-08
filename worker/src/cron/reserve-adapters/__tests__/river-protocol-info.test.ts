import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonAdapterInput: vi.fn(),
    fetchOnchainMulticall3: vi.fn(),
  };
});

import { fetchJsonAdapterInput, fetchOnchainMulticall3 } from "../helpers";
import { adaptRiverProtocolInfo, fetchRiverProtocolInfoReserves } from "../river-protocol-info";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

const SATUSD_BY_CHAIN: Record<string, string> = {
  ethereum: "0x1958853a8be062dc4f401750eb233f5850f0d0d2",
  base: "0x70654aad8b7734dc319d0c3608ec7b32e03fa162",
};
const TROVE_MANAGER_BY_CHAIN: Record<string, string[]> = {
  ethereum: ["0xb97e6219b0836e21ae671358e746f03dcdbcb6d8", "0xc03403dd8f27cefa314fc109d26777c81b0de895"],
  base: ["0xddac7d4e228c205197fe9961865ffe20173de56b"],
};
const ONE = 10n ** 18n;
const REDEMPTION_FEE_FLOOR = ONE / 200n; // 0.5%

const unexpectedRequests: string[] = [];
afterEach(() => expect(unexpectedRequests.splice(0)).toEqual([]));
interface ChainState {
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

function word(value: bigint | boolean | string): `0x${string}` {
  if (typeof value === "string") {
    return `0x${value.replace(/^0x/, "").toLowerCase().padStart(64, "0")}` as `0x${string}`;
  }
  const uint = typeof value === "boolean" ? (value ? 1n : 0n) : value;
  return `0x${uint.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function defaultChainState(chain: string): ChainState {
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

// Independent request identities: labels are returned but never choose values.
function primeRiverChainMocks(overrides: Record<string, Partial<ChainState>> = {}) {
  vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls, chain }) => {
    const apps: Record<string, string> = {
      ethereum: "0xb8374e4dff99202292da2fe34425e1de665b67e6",
      base: "0x9a3c724ee9603a7550499be73dc743b371811dd3",
    };
    if (chain === undefined || !apps[chain]) {
      unexpectedRequests.push(String(chain));
      throw new Error(`Unexpected chain ${chain}`);
    }
    const state = { ...defaultChainState(chain), ...(overrides[chain] ?? {}) };
    if (state.fail) return null;
    const satUsd = state.debtToken ?? SATUSD_BY_CHAIN[chain];
    const appValues: Record<string, `0x${string}`> = {
      "0xf8d89898": word(satUsd),
      "0x716c53c2": `${word(ONE)}${word(state.totalDebt).slice(2)}`,
      "0xb620115d": word(state.tcr),
      "0x679df0d9": word(BigInt(state.troveManagers.length)),
    };
    return calls.map(({ label, contract, data }) => {
      let returnData: `0x${string}` | undefined;
      if (contract.toLowerCase() === apps[chain]) {
        returnData = appValues[data];
        if (/^0x3b707478[0-9a-f]{64}$/.test(data)) {
          const index = Number(BigInt(`0x${data.slice(10)}`));
          if (index >= 12) {
            unexpectedRequests.push(`manager slot ${index}`);
            throw new Error(`Unexpected manager slot ${index}`);
          }
          if (index >= state.troveManagers.length) return { label, success: false, returnData: "0x" as const };
          returnData = word(state.troveManagers[index]);
        }
      } else {
        const index = state.troveManagers.indexOf(contract.toLowerCase());
        if (index >= 0) {
          const branchValues: Record<string, `0x${string}`> = {
            "0xf8d89898": word(state.branchDebtToken ?? satUsd),
            "0xc52861f2": word(state.rates[index]),
            "0x794e5724": word(state.mcrs[index]),
            "0x9484fb8e": word(state.sunsetting[index]),
          };
          returnData = branchValues[data];
        }
      }
      if (!returnData) {
        unexpectedRequests.push(`${chain} ${contract} ${data}`);
        throw new Error(`Unexpected River call ${chain} ${contract} ${data}`);
      }
      return { label, success: true, returnData };
    });
  });
}

function makeCoin(): StablecoinMeta {
  return {
    id: "satusd-river",
    name: "River satUSD",
    ticker: "satUSD",
    contracts: [
      { chain: "ethereum", address: SATUSD_BY_CHAIN.ethereum, decimals: 18 },
      { chain: "base", address: SATUSD_BY_CHAIN.base, decimals: 18 },
      // Not in the pinned Satoshi app registry — must never be probed.
      { chain: "bob", address: "0xecf21b335b41f9d5a89f6186a99c19a3c467871f", decimals: 18 },
    ],
  } as unknown as StablecoinMeta;
}

const liveConfig: LiveReservesConfig = {
  adapter: "river-protocol-info",
  version: 1,
  semantics: "protocol-reserve",
  inputs: { primary: { kind: "http-json", url: "https://api-airdrop.river.inc/protocol-info" } },
} as unknown as LiveReservesConfig;

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
      collateralizationRatio: 2,
      chainCirculatingCount: 1,
      tvlPointCount: 1,
      circulatingPointCount: 1,
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

  it("degrades when protocol TVL falls below circulating satUSD", () => {
    const result = adaptRiverProtocolInfo({
      tvl: 640,
      circulatingSupply: 1000,
    });

    expect(result.metadata?.collateralizationRatio).toBe(0.64);
    expect(result.warnings?.[0]).toMatchObject({
      code: "reserve-undercollateralized",
      effect: "degraded",
    });
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
  beforeEach(() => {
    vi.clearAllMocks();
    primeRiverChainMocks();
    vi.mocked(fetchJsonAdapterInput).mockResolvedValue({
      tvl: 250_000_000,
      circulatingSupply: 159_000_000,
      tvlData: [{ timestamp: 1_776_290_400, value: 250_000_000 }],
      circulatingData: [{ timestamp: 1_776_290_400, value: 159_000_000 }],
    } as never);
  });

  it("drops a chain with a mismatched branch debt token", async () => {
    primeRiverChainMocks({ base: { branchDebtToken: "0x1111111111111111111111111111111111111111" } });
    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, new AbortController().signal);
    expect(result.metadata?.redemption?.capacityUsd).toBe(100_000);
    expect(result.metadata?.details).toMatchObject({ redeemRoute: { droppedChains: ["base"] } });
  });

  it("keeps verified capacity but omits fees if any chain reports a rate above 100%", async () => {
    primeRiverChainMocks({ base: { rates: [ONE + 1n] } });
    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, new AbortController().signal);
    expect(result.metadata?.redemption?.capacityUsd).toBe(9_100_000);
    expect(result.metadata?.redemption?.feeBps).toBeUndefined();
  });

  it("accepts TCR exactly equal to the deepest MCR", async () => {
    primeRiverChainMocks({ base: { tcr: 3n * ONE, mcrs: [3n * ONE] } });
    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, new AbortController().signal);
    expect(result.metadata?.redemption?.capacityUsd).toBe(9_100_000);
  });

  it("propagates RPC cancellation instead of emitting unreadable telemetry", async () => {
    const controller = new AbortController();
    const error = new DOMException("Cancelled", "AbortError");
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async () => {
      controller.abort(error);
      throw error;
    });
    await expect(fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, controller.signal)).rejects.toBe(error);
  });

  it("ignores reverting unused manager slots while summing debt and bounding branch fees", async () => {
    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, AbortSignal.timeout(5_000));

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
    await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, AbortSignal.timeout(5_000));

    const probedChains = vi.mocked(fetchOnchainMulticall3).mock.calls
      .map((call) => (call[0] as { chain: string }).chain);
    expect(new Set(probedChains)).toEqual(new Set(["ethereum", "base"]));
  });

  it("drops a chain whose debtToken() no longer round-trips to the tracked satUSD", async () => {
    primeRiverChainMocks({ base: { debtToken: "0x1111111111111111111111111111111111111111" } });

    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, AbortSignal.timeout(5_000));

    expect(result.metadata?.redemption?.capacityUsd).toBe(100_000);
    expect(result.metadata?.details).toMatchObject({ redeemRoute: { droppedChains: ["base"] } });
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "river-redemption-partial-chain-coverage", effect: "info" }),
      ]),
    );
  });

  it("drops a chain whose global TCR sits below its deepest branch MCR", async () => {
    // redeemCollateral() reverts with "Cannot redeem when TCR < MCR".
    primeRiverChainMocks({ base: { tcr: (12n * ONE) / 10n, mcrs: [(15n * ONE) / 10n] } });

    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, AbortSignal.timeout(5_000));

    expect(result.metadata?.redemption?.capacityUsd).toBe(100_000);
    expect(result.metadata?.details).toMatchObject({ redeemRoute: { droppedChains: ["base"] } });
  });

  it("drops a chain whose branch count outgrows the speculative enumeration window", async () => {
    primeRiverChainMocks({ base: { troveManagers: new Array(13).fill(TROVE_MANAGER_BY_CHAIN.base[0]) } });

    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, AbortSignal.timeout(5_000));

    expect(result.metadata?.details).toMatchObject({ redeemRoute: { droppedChains: ["base"] } });
  });

  it("carries the highest branch rate across chains rather than the floor", async () => {
    primeRiverChainMocks({ base: { rates: [ONE / 20n] } }); // 5%

    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, AbortSignal.timeout(5_000));

    expect(result.metadata?.redemption?.feeBps).toBe(500);
  });

  it("publishes the measured zero capacity without claiming the route is open", async () => {
    primeRiverChainMocks({ ethereum: { totalDebt: 0n }, base: { totalDebt: 0n } });

    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, AbortSignal.timeout(5_000));

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, feeBps: 50 });
    expect(result.metadata?.redemption?.routeStatus).toBeUndefined();
    expectValidAdapterOutput("river-protocol-info", result);
  });

  it("withholds the whole redemption block when no chain verifies", async () => {
    primeRiverChainMocks({ ethereum: { fail: true }, base: { fail: true } });

    const result = await fetchRiverProtocolInfoReserves(makeCoin(), liveConfig, AbortSignal.timeout(5_000));

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.details?.redeemRoute).toBeUndefined();
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "river-redemption-unreadable", effect: "info" }),
      ]),
    );
    expectValidAdapterOutput("river-protocol-info", result);
  });
});
