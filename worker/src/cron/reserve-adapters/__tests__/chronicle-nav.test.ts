import { beforeEach, describe, expect, it, vi } from "vitest";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../../lib/evm-selectors";
import {
  adaptChronicleNavResponse,
  decodeChronicleReadWithAge,
  fetchChronicleNavReserves,
  type ChronicleNavParams,
} from "../chronicle-nav";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchOnchainUint256,
    fetchOnchainRawCall,
    makeOnchainCallers: makeOnchainCallersMock({
      uint256: fetchOnchainUint256,
      raw: fetchOnchainRawCall,
    }),
  };
});

const CONSUMER_ADDRESS = "0x9a3bF392f86acd1b1EC07d026B326302eAED7488";
const TOKEN_ADDRESS = "0x51c2d74017390cbbd30550179a16a1c28f7210fc";
const NOW_SEC = 1_786_700_000;

function encodeUint256Word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodeReadWithAge(value: bigint, age: number): `0x${string}` {
  return `0x${encodeUint256Word(value)}${encodeUint256Word(BigInt(age))}` as `0x${string}`;
}

function baseParams(): ChronicleNavParams {
  return {
    consumerAddress: CONSUMER_ADDRESS,
    tokenAddress: TOKEN_ADDRESS,
    assetLabel: "Securitize Tokenized AAA CLO Fund NAV",
    assetRisk: "high",
    maxOracleAgeSec: 345_600,
  };
}

function baseConfig() {
  return {
    adapter: "chronicle-nav" as const,
    version: 1,
    semantics: "single-asset" as const,
    inputs: {
      primary: { kind: "onchain-evm" as const, chain: "ethereum", rpcMode: "public-rpc" as const },
    },
    params: baseParams(),
  };
}

async function mockOnchain(args: {
  value?: bigint;
  age?: number;
  tokenDecimals?: bigint | null;
  totalSupply?: bigint | null;
} = {}): Promise<void> {
  const helpers = await import("../helpers");
  const value = args.value ?? 1_027_991_334_000_000_000n;
  const age = args.age ?? NOW_SEC - 60;
  vi.mocked(helpers.fetchOnchainRawCall).mockImplementation(async ({ contract, data }) =>
    contract === CONSUMER_ADDRESS && data === "0x393e5ede" ? encodeReadWithAge(value, age) : null,
  );
  vi.mocked(helpers.fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
    if (contract !== TOKEN_ADDRESS) return null;
    if (data === DECIMALS_SELECTOR) return args.tokenDecimals ?? 6n;
    if (data === TOTAL_SUPPLY_SELECTOR) return args.totalSupply === undefined ? 345_256_379_791n : args.totalSupply;
    return null;
  });
}

describe("decodeChronicleReadWithAge", () => {
  it("decodes the uint256 NAV value and uint256 age timestamp", () => {
    expect(decodeChronicleReadWithAge(encodeReadWithAge(1_027_991_334_000_000_000n, NOW_SEC))).toEqual({
      value: 1_027_991_334_000_000_000n,
      age: NOW_SEC,
    });
  });

  it("rejects a payload that is not exactly two ABI words", () => {
    expect(() => decodeChronicleReadWithAge("0xdeadbeef")).toThrow("malformed payload");
  });
});

describe("adaptChronicleNavResponse", () => {
  it("emits one configured 100% NAV slice with verified freshness", () => {
    const result = adaptChronicleNavResponse(
      {
        navPerToken: 1_027_991_334_000_000_000n,
        totalSupply: 345_256_379_791n,
        tokenDecimals: 6,
        updatedAt: NOW_SEC,
      },
      baseParams(),
    );

    expect(result.slices).toEqual([
      { name: "Securitize Tokenized AAA CLO Fund NAV", pct: 100, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      navPerToken: "1.027991334",
      totalSupplyFormatted: "345256.379791",
      totalSupplyRaw: "345256379791",
      navDecimals: 18,
      tokenDecimals: 6,
      oracleUpdatedAt: NOW_SEC,
      oracleTimestampSource: "chronicle-readWithAge",
      sourceTimestamp: NOW_SEC,
      freshnessMode: "verified",
    });
  });

  it("rejects a zero NAV value", () => {
    expect(() => adaptChronicleNavResponse(
      { navPerToken: 0n, totalSupply: 1n, tokenDecimals: 6, updatedAt: NOW_SEC },
      baseParams(),
    )).toThrow("zero or negative NAV");
  });
});

describe("fetchChronicleNavReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads readWithAge(), token decimals(), and token totalSupply()", async () => {
    await mockOnchain();

    const result = await fetchChronicleNavReserves(
      {} as never,
      baseConfig() as never,
      new AbortController().signal,
      { nowSec: NOW_SEC },
    );

    expect(result.metadata?.freshnessMode).toBe("verified");
    const helpers = await import("../helpers");
    expect(helpers.fetchOnchainRawCall).toHaveBeenCalledWith(
      expect.objectContaining({ contract: CONSUMER_ADDRESS, data: "0x393e5ede" }),
    );
    expect(helpers.fetchOnchainUint256).toHaveBeenCalledWith(
      expect.objectContaining({ contract: TOKEN_ADDRESS, data: DECIMALS_SELECTOR }),
    );
    expect(helpers.fetchOnchainUint256).toHaveBeenCalledWith(
      expect.objectContaining({ contract: TOKEN_ADDRESS, data: TOTAL_SUPPLY_SELECTOR }),
    );
  });

  it("rejects a stale readWithAge() timestamp", async () => {
    await mockOnchain({ age: NOW_SEC - 345_601 });

    await expect(fetchChronicleNavReserves(
      {} as never,
      baseConfig() as never,
      new AbortController().signal,
      { nowSec: NOW_SEC },
    )).rejects.toThrow("data is stale (345601s > 345600s)");
  });

  it("rejects a readWithAge() timestamp too far in the future", async () => {
    await mockOnchain({ age: NOW_SEC + 601 });

    await expect(fetchChronicleNavReserves(
      {} as never,
      baseConfig() as never,
      new AbortController().signal,
      { nowSec: NOW_SEC },
    )).rejects.toThrow("age timestamp is in the future (601s)");
  });

  it("rejects an invalid zero NAV from readWithAge()", async () => {
    await mockOnchain({ value: 0n });

    await expect(fetchChronicleNavReserves(
      {} as never,
      baseConfig() as never,
      new AbortController().signal,
      { nowSec: NOW_SEC },
    )).rejects.toThrow("zero or negative NAV");
  });

  it("rejects a failed token totalSupply() read", async () => {
    await mockOnchain({ totalSupply: null });

    await expect(fetchChronicleNavReserves(
      {} as never,
      baseConfig() as never,
      new AbortController().signal,
      { nowSec: NOW_SEC },
    )).rejects.toThrow("token totalSupply() call failed");
  });
});
