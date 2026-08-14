import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsdaiHubReserves, type UsdaiHubParams } from "../usdai-hub";

const rawCall = vi.hoisted(() => vi.fn());
const storageCall = vi.hoisted(() => vi.fn());

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    makeOnchainCallers: vi.fn(() => ({
      raw: rawCall,
      uint256: vi.fn(),
    })),
  };
});

vi.mock("../../../lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/evm-rpc")>();
  return { ...actual, fetchEvmStorageAtBlock: storageCall };
});

const ADDRESSES = {
  hub: "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF",
  baseToken: "0x46850aD61C2B7d64d08c9C754F45254596696984",
  implementation: "0x0ab74df531c0d8f1c46643e404b3d14723bbc212",
  otherToken: "0x00000000000000000000000000000000000000ab",
} as const;

const TOTAL_SUPPLY = 200_750_740_926_947_878_099_813_249n;
const BRIDGED_SUPPLY = 2_135_653_492_985_000_000_000_000n;
const PYUSD_BALANCE = 202_886_394_432_337n;

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function addressWord(address: string): `0x${string}` {
  return word(BigInt(address));
}

const CONFIG = {
  adapter: "usdai-hub" as const,
  version: 1,
  semantics: "single-asset" as const,
  breakerScope: "usdai-usd-ai",
  inputs: {
    primary: { kind: "onchain-evm" as const, chain: "arbitrum", rpcMode: "public-rpc" as const },
  },
  params: {
    hubAddress: ADDRESSES.hub,
    baseTokenAddress: ADDRESSES.baseToken,
    implementationAddress: ADDRESSES.implementation,
    redemptionCapacity: {
      holderEligibility: "whitelisted-primary" as const,
      sourceUrls: ["https://usd.ai/insights/usdai-mint-redeem-upgrade"],
    },
  } satisfies UsdaiHubParams,
};

function installReads(overrides: {
  baseToken?: string;
  balance?: `0x${string}`;
  totalSupply?: `0x${string}`;
  bridgedSupply?: `0x${string}`;
  paused?: `0x${string}`;
  implementation?: string;
} = {}): void {
  const values = new Map<string, `0x${string}`>([
    [`${ADDRESSES.hub.toLowerCase()}:0xc55dae63`, addressWord(overrides.baseToken ?? ADDRESSES.baseToken)],
    [`${ADDRESSES.baseToken.toLowerCase()}:0x70a08231${ADDRESSES.hub.slice(2).toLowerCase().padStart(64, "0")}`, word(overrides.balance === undefined ? PYUSD_BALANCE : BigInt(overrides.balance))],
    [`${ADDRESSES.hub.toLowerCase()}:0x18160ddd`, overrides.totalSupply ?? word(TOTAL_SUPPLY)],
    [`${ADDRESSES.hub.toLowerCase()}:0x11c301e0`, overrides.bridgedSupply ?? word(BRIDGED_SUPPLY)],
    [`${ADDRESSES.hub.toLowerCase()}:0x5c975abb`, overrides.paused ?? word(0n)],
  ]);
  rawCall.mockImplementation(async (contract: string, data: string) => values.get(`${contract.toLowerCase()}:${data}`) ?? null);
  storageCall.mockResolvedValue(addressWord(overrides.implementation ?? ADDRESSES.implementation));
}

async function fetchFixture(config = CONFIG) {
  return fetchUsdaiHubReserves(
    { id: "usdai-usd-ai" } as never,
    config as never,
    new AbortController().signal,
  );
}

describe("usdai-hub adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReads();
  });

  it("emits the measured 100% PYUSD slice and complete bridge-safe liability", async () => {
    const output = await fetchFixture();

    expect(output.slices).toEqual([
      {
        name: "PYUSD held by the canonical USDai hub",
        pct: 100,
        risk: "low",
        coinId: "pyusd-paypal",
        depType: "collateral",
      },
    ]);
    expect(output.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalSupplyRaw: TOTAL_SUPPLY.toString(),
      supplyUsd: 202_886_394.41993288,
      totalReserveUsd: 202_886_394.432337,
      collateralizationRatio: expect.closeTo(1.000000000061126, 12),
      details: {
        bridgedSupplyRaw: BRIDGED_SUPPLY.toString(),
        bridgeSafeLiabilityRaw: (TOTAL_SUPPLY + BRIDGED_SUPPLY).toString(),
        paused: false,
      },
      redemption: {
        capacityUsd: 202_886_394.432337,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "whitelisted-primary",
      },
    });
  });

  it("fails closed when baseToken() does not resolve to the pinned PYUSD", async () => {
    installReads({ baseToken: ADDRESSES.otherToken });

    await expect(fetchFixture()).rejects.toThrow("baseToken() identity mismatch");
  });

  it("fails closed when the implementation slot drifts", async () => {
    installReads({ implementation: ADDRESSES.otherToken });

    await expect(fetchFixture()).rejects.toThrow("EIP-1967 implementation identity mismatch");
  });

  it("fails closed when PYUSD is below canonical plus bridged liabilities", async () => {
    installReads({ balance: word(PYUSD_BALANCE - 20_000n) });

    await expect(fetchFixture()).rejects.toThrow("below bridge-safe USDai liabilities");
  });

  it("preserves redemption telemetry and marks a paused hub as paused", async () => {
    installReads({ paused: word(1n) });

    const output = await fetchFixture();

    expect(output.slices).toHaveLength(1);
    expect(output.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: "USDai hub paused() returned true on-chain",
      capacityUsd: 202_886_394.432337,
    });
    expect(output.metadata?.details).toMatchObject({ paused: true });
  });

  it("rejects malformed ABI payloads instead of publishing a partial snapshot", async () => {
    installReads({ paused: "0x1234" as `0x${string}` });

    await expect(fetchFixture()).rejects.toThrow("paused() returned malformed bool payload");
  });
});
