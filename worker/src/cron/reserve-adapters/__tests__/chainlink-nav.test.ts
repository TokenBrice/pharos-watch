import { beforeEach, describe, it, expect, vi } from "vitest";
import { parseChainlinkLatestRoundData } from "../chainlink";
import {
  adaptChainlinkNavResponse,
  parseOndoPriceData,
  type ChainlinkNavParams,
} from "../chainlink-nav";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchOnchainUint256: vi.fn(),
    fetchOnchainRawCall: vi.fn(),
  };
});

const ORACLE_ADDRESS = "0x74f2199AEb743f68f05943e5715A33EaF2b61f53";
const WRAPPER_ADDRESS = "0x00000000000000000000000000000000000000aa";
const TOKEN_ADDRESS = "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b";

describe("adaptChainlinkNavResponse", () => {
  const params: ChainlinkNavParams = {
    oracleAddress: "0x74f2199AEb743f68f05943e5715A33EaF2b61f53",
    tokenAddress: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b",
    assetLabel: "U.S. Treasury Bills",
    assetRisk: "very-low",
  };

  it("returns single 100% slice", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000n, navDecimals: 6, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 384n, updatedAt: 1773405239 },
      params,
    );
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].name).toBe("U.S. Treasury Bills");
  });

  it("calculates AUM in metadata", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000n, navDecimals: 6, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 384n, updatedAt: 1773405239 },
      params,
    );
    // NAV = 1.119, Supply = 500
    expect(result.metadata?.navPerToken).toBe("1.119");
    expect(result.metadata?.totalSupplyFormatted).toBe("500");
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.sourceTimestamp).toBe(1773405239);
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-bound",
      freshnessKind: "verified-source-timestamp",
      sourceTimestamp: 1773405239,
      routeStatus: "unknown",
    });
  });

  it("throws on zero NAV", () => {
    expect(() =>
      adaptChainlinkNavResponse(
        { navPerToken: 0n, navDecimals: 6, totalSupply: 500n, tokenDecimals: 6, roundId: 1n, updatedAt: 0 },
        params,
      ),
    ).toThrow();
  });

  it("marks getPrice mode as explicitly unverified when no oracle timestamp exists", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000_000_000_000_000n, navDecimals: 18, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 0n, updatedAt: 0 },
      params,
    );

    expect(result.metadata).toMatchObject({
      oracleTimestampSource: "unavailable",
      freshnessMode: "unverified",
      details: {
        freshnessSource: "onchain-oracle-getprice",
      },
    });
  });
});

describe("parseChainlinkLatestRoundData", () => {
  const validHex = "0x"
    + "0000000000000000000000000000000000000000000000000000000000000001" // roundId
    + "000000000000000000000000000000000000000000000000000000003b9aca00" // answer (1e9)
    + "0000000000000000000000000000000000000000000000000000000065a8f000" // startedAt
    + "0000000000000000000000000000000000000000000000000000000065a8f100" // updatedAt
    + "0000000000000000000000000000000000000000000000000000000000000001"; // answeredInRound

  it("parses a valid 5-word hex response", () => {
    const result = parseChainlinkLatestRoundData(validHex, "test");
    expect(result.roundId).toBe(1n);
    expect(result.answer).toBe(1_000_000_000n);
    expect(result.updatedAt).toBeGreaterThan(0);
  });

  it("throws on short hex response (< 256 chars)", () => {
    const shortHex = "0x" + "00".repeat(80); // 160 hex chars
    expect(() => parseChainlinkLatestRoundData(shortHex, "test")).toThrow("too short");
  });

  it("throws on zero answer", () => {
    const zeroAnswer = "0x"
      + "0000000000000000000000000000000000000000000000000000000000000001"
      + "0000000000000000000000000000000000000000000000000000000000000000" // answer = 0
      + "0000000000000000000000000000000000000000000000000000000065a8f000"
      + "0000000000000000000000000000000000000000000000000000000065a8f100"
      + "0000000000000000000000000000000000000000000000000000000000000001";
    expect(() => parseChainlinkLatestRoundData(zeroAnswer, "test")).toThrow("non-positive answer");
  });

  it("throws on zero updatedAt", () => {
    const zeroUpdatedAt = "0x"
      + "0000000000000000000000000000000000000000000000000000000000000001"
      + "000000000000000000000000000000000000000000000000000000003b9aca00"
      + "0000000000000000000000000000000000000000000000000000000065a8f000"
      + "0000000000000000000000000000000000000000000000000000000000000000" // updatedAt = 0
      + "0000000000000000000000000000000000000000000000000000000000000001";
    expect(() => parseChainlinkLatestRoundData(zeroUpdatedAt, "test")).toThrow("non-positive updatedAt");
  });
});

describe("parseOndoPriceData", () => {
  it("parses price and timestamp from a two-word payload", () => {
    const raw = "0x"
      + "00000000000000000000000000000000000000000000000639e961576659e000"
      + "0000000000000000000000000000000000000000000000000000000069d6caf3";

    expect(parseOndoPriceData(raw)).toEqual({
      price: 114_853_438_000_000_000_000n,
      updatedAt: 1775684339,
    });
  });

  it("throws on malformed payloads", () => {
    expect(() => parseOndoPriceData("0x1234")).toThrow("malformed payload");
  });
});

describe("fetchChainlinkNavReserves getAssetPrice wrapper-oracle parse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits chainlink-nav-wrapper-oracle-malformed when the wrapper oracle returns garbage", async () => {
    const helpers = await import("../helpers");
    const { fetchChainlinkNavReserves } = await import("../chainlink-nav");

    vi.mocked(helpers.fetchOnchainUint256).mockImplementation(async (opts) => {
      if (opts.data === "0x313ce567") return 6n; // decimals()
      if (opts.data === "0x18160ddd") return 500_000_000n; // totalSupply()
      if (opts.data.startsWith("0xb3596f07")) return 1_000_000_000_000_000_000n; // getAssetPrice(addr) → 1e18
      return null;
    });
    vi.mocked(helpers.fetchOnchainRawCall).mockImplementation(async (opts) => {
      if (opts.data.startsWith("0xeca6f018")) {
        // tokenToRwaOracle(addr) returns wrapper address
        return `0x000000000000000000000000${WRAPPER_ADDRESS.slice(2)}` as `0x${string}`;
      }
      if (opts.data === "0xa4a28168" && opts.contract === WRAPPER_ADDRESS) {
        // Malformed getPriceData() payload — wrong length
        return "0xdeadbeef";
      }
      return null;
    });

    const config = {
      adapter: "chainlink-nav" as const,
      version: 1,
      semantics: "collateral-mix" as const,
      inputs: {
        primary: { kind: "onchain-evm" as const, chain: "ethereum", rpcMode: "public-rpc" as const },
      },
      params: {
        oracleAddress: ORACLE_ADDRESS,
        tokenAddress: TOKEN_ADDRESS,
        assetLabel: "Ondo T-Bills",
        assetRisk: "very-low" as const,
        oracleMethod: "getAssetPrice" as const,
      },
    };

    const result = await fetchChainlinkNavReserves(
      {} as never,
      config as never,
      new AbortController().signal,
    );

    expect(result.warnings?.some((w) => w.code === "chainlink-nav-wrapper-oracle-malformed")).toBe(true);
    // freshness falls through to unverified (no valid wrapper timestamp)
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });
});
