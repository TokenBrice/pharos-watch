import { beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * Serve the two multicall phases per chain off a per-chain state object: the
 * probe resolves branch addresses in the first batch and reads them back in the
 * second, so the mock has to answer by label rather than by call order.
 */
function primeRiverChainMocks(overrides: Record<string, Partial<ChainState>> = {}) {
  vi.mocked(fetchOnchainMulticall3).mockImplementation((args: unknown) => {
    const { calls, chain } = args as { calls: Array<{ label: string }>; chain: string };
    const state = { ...defaultChainState(chain), ...(overrides[chain] ?? {}) };
    if (state.fail) return Promise.resolve(null);
    const satUsd = state.debtToken ?? SATUSD_BY_CHAIN[chain];

    return Promise.resolve(calls.map(({ label }) => {
      const returnData = ((): `0x${string}` => {
        if (label === "app:debt-token") return word(satUsd);
        if (label === "app:balances") return `${word(ONE)}${word(state.totalDebt).slice(2)}` as `0x${string}`;
        if (label === "app:tcr") return word(state.tcr);
        if (label === "app:trove-manager-count") return word(BigInt(state.troveManagers.length));
        const appIndex = label.match(/^app:trove-manager:(\d+)$/);
        if (appIndex) return word(state.troveManagers[Number(appIndex[1])] ?? 0n);
        const branch = label.match(/^branch:([a-z-]+):(\d+)$/);
        if (!branch) return word(0n);
        const index = Number(branch[2]);
        if (branch[1] === "debt-token") return word(state.branchDebtToken ?? satUsd);
        if (branch[1] === "rate") return word(state.rates[index]);
        if (branch[1] === "mcr") return word(state.mcrs[index]);
        return word(state.sunsetting[index]);
      })();
      return { label, success: true, returnData };
    }));
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

  it("sums per-chain trove debt and reports the highest branch redemption rate", async () => {
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
