import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import { fetchSaturnPyusdxReserves } from "../saturn-pyusdx";

const multicallCall = vi.hoisted(() => vi.fn());
const storageCall = vi.hoisted(() => vi.fn());

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchOnchainMulticall3: multicallCall,
  };
});

vi.mock("../../../lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/evm-rpc")>();
  return { ...actual, fetchEvmStorageAtBlock: storageCall };
});

const ADDRESSES = {
  wrapper: "0x23238f20b894f29041f48d88ee91131c395aaa71",
  implementation: "0x496a4a33b6181f4536203488d9a05ac1429e702c",
  pyusdx: "0xebdb0942ce16386ab90718c7bd10c91cdb66b14d",
  other: "0x00000000000000000000000000000000000000ab",
} as const;

const SUPPLY = 64_224_919_545249n;
const BALANCE = 64_224_919_545249n;

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function addressWord(address: string): `0x${string}` {
  return word(BigInt(address));
}

const CONFIG = {
  adapter: "saturn-pyusdx" as const,
  version: 1,
  semantics: "single-asset" as const,
  breakerScope: "usdat-saturn",
  inputs: {
    primary: { kind: "onchain-evm" as const, chain: "ethereum", rpcMode: "public-rpc" as const },
  },
  params: {
    wrapperAddress: ADDRESSES.wrapper,
    expectedImplementation: ADDRESSES.implementation,
    underlyingToken: ADDRESSES.pyusdx,
    slice: {
      name: "PYUSDx held by Saturn USDat",
      risk: "low" as const,
      coinId: "pyusd-paypal" as const,
      depType: "wrapper" as const,
    },
  },
};

function installReads(overrides: {
  implementation?: string;
  pyusdx?: string;
  supply?: bigint;
  balance?: bigint;
  paused?: bigint;
  decimals?: bigint;
} = {}): void {
  const decimals = overrides.decimals ?? 6n;
  const wrapper = ADDRESSES.wrapper.toLowerCase();
  const pyusdx = ADDRESSES.pyusdx.toLowerCase();
  const values = new Map<string, `0x${string}`>([
    [`${wrapper}:0xda6b76b8`, addressWord(overrides.pyusdx ?? ADDRESSES.pyusdx)],
    [`${wrapper}:0x18160ddd`, word(overrides.supply ?? SUPPLY)],
    [`${wrapper}:0x313ce567`, word(decimals)],
    [`${pyusdx}:${encodeBalanceOfCallData(wrapper)}`, word(overrides.balance ?? BALANCE)],
    [`${pyusdx}:0x313ce567`, word(decimals)],
    [`${wrapper}:0x5c975abb`, word(overrides.paused ?? 0n)],
  ]);
  multicallCall.mockImplementation(async ({ calls }: { calls: Array<{ label: string; contract: string; data: string }> }) =>
    calls.map((call) => {
      const value = values.get(`${call.contract.toLowerCase()}:${call.data.toLowerCase()}`);
      return { label: call.label, success: value != null, returnData: value ?? "0x" };
    }),
  );
  storageCall.mockResolvedValue(addressWord(overrides.implementation ?? ADDRESSES.implementation));
}

async function fetchFixture() {
  return fetchSaturnPyusdxReserves(
    { id: "usdat-saturn" } as never,
    CONFIG as never,
    new AbortController().signal,
  );
}

describe("saturn-pyusdx adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReads();
  });

  it("emits the measured 100% PYUSDx slice with the canonical PYUSD dependency", async () => {
    const output = await fetchFixture();

    expect(output.slices).toEqual([
      {
        name: "PYUSDx held by Saturn USDat",
        pct: 100,
        risk: "low",
        coinId: "pyusd-paypal",
        depType: "wrapper",
      },
    ]);
    expect(output.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: { proofKind: "saturn-pyusdx-wrapper-balance" },
      wrapperAddress: ADDRESSES.wrapper,
      implementationAddress: ADDRESSES.implementation,
      pyusdxAddress: ADDRESSES.pyusdx,
      totalSupplyRaw: SUPPLY.toString(),
      underlyingBalanceRaw: BALANCE.toString(),
      wrapperDecimals: 6,
      underlyingDecimals: 6,
      collateralizationRatio: 1,
      redemption: {
        capacityUsd: 64_224_919.545249,
        capacityRatioOfSupply: 1,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "whitelisted-primary",
        settlementDelaySec: 0,
      },
    });
    expect(output.warnings).toBeUndefined();
  });

  it("fails closed when the EIP-1967 implementation slot drifts", async () => {
    installReads({ implementation: ADDRESSES.other });

    await expect(fetchFixture()).rejects.toThrow("EIP-1967 implementation identity mismatch");
  });

  it("fails closed when pyusdx() does not resolve to the pinned PYUSDx token", async () => {
    installReads({ pyusdx: ADDRESSES.other });

    await expect(fetchFixture()).rejects.toThrow("pyusdx() identity mismatch");
  });

  it("publishes PYUSDx below supply as degraded instead of erroring (E4)", async () => {
    installReads({ balance: 59_000_000_000000n });

    const output = await fetchFixture();
    expect(output.slices).toEqual([
      {
        name: "PYUSDx held by Saturn USDat",
        pct: 100,
        risk: "low",
        coinId: "pyusd-paypal",
        depType: "wrapper",
      },
    ]);
    expect(output.metadata?.collateralizationRatio).toBeCloseTo(59_000_000 / 64_224_919.545249, 6);
    expect(output.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
        severity: "warning",
        message: "Saturn USDat PYUSDx balance covers 91.86% of USDat supply",
      }),
    ]);
  });

  it("degrades zero supply and reports a paused MultiMint route as paused", async () => {
    installReads({ supply: 0n, paused: 1n });

    const output = await fetchFixture();
    expect(output.metadata?.collateralizationRatio).toBeUndefined();
    expect(output.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: "Saturn USDat MultiMint paused() returned true on-chain",
    });
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }),
        expect.objectContaining({ code: "route-paused", effect: "degraded" }),
      ]),
    );
  });
});
