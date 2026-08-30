import { beforeEach, describe, it, expect, vi } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseChainlinkLatestRoundData } from "../../../lib/chainlink-round-data";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../../lib/evm-selectors";
import {
  adaptChainlinkNavResponse,
  parseOndoPriceData,
  type ChainlinkNavParams,
} from "../chainlink-nav-core";

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

const ORACLE_ADDRESS = "0x74f2199AEb743f68f05943e5715A33EaF2b61f53";
const WRAPPER_ADDRESS = "0x00000000000000000000000000000000000000aa";
const TOKEN_ADDRESS = "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b";
const MANAGER_ADDRESS = "0x93358db73B6cd4b98D89c8F5f230E81a95c2643a";
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ROUTER_ADDRESS = "0x99B8d1D1c17a10CD1A878d1A44c11fd7E4daD7bC";
const SOURCE_ADDRESS = "0x9F205E1aC7698F59EdbAa0a28C4A4c4ed605b722";

function encodeUint256Word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodeAddressResult(address: string): `0x${string}` {
  return `0x${address.slice(2).padStart(64, "0")}` as `0x${string}`;
}

function encodeUint256Result(value: bigint): `0x${string}` {
  return `0x${encodeUint256Word(value)}`;
}

function makeChainlinkNavConfig(
  overrides: {
    semantics?: "single-asset" | "collateral-mix";
    params?: Record<string, unknown>;
  } = {},
): LiveReservesConfig {
  return {
    adapter: "chainlink-nav",
    version: 1,
    semantics: overrides.semantics ?? "single-asset",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
    },
    params: {
      oracleAddress: ORACLE_ADDRESS,
      tokenAddress: TOKEN_ADDRESS,
      ...overrides.params,
    },
  };
}

function encodeLatestRoundData(args: {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}): `0x${string}` {
  return `0x${encodeUint256Word(args.roundId)}${encodeUint256Word(args.answer)}${
    encodeUint256Word(args.startedAt)
  }${encodeUint256Word(args.updatedAt)}${encodeUint256Word(args.answeredInRound)}`;
}

describe("adaptChainlinkNavResponse", () => {
  const params: ChainlinkNavParams = {
    oracleAddress: "0x74f2199AEb743f68f05943e5715A33EaF2b61f53",
    tokenAddress: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b",
    assetLabel: "U.S. Treasury Bills",
    assetRisk: "very-low",
    sourceKey: "chainlink-nav:test",
  };

  it("returns single 100% slice", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000n, navDecimals: 6, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 384n, updatedAt: 1773405239 },
      params,
    );
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].sourceKey).toBe("chainlink-nav:test");
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

describe("fetchChainlinkNavCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when standard Chainlink NAV round data exceeds the configured freshness window", async () => {
    const helpers = await import("../helpers");
    const { fetchChainlinkNavCore } = await import("../chainlink-nav-core");
    const updatedAt = 1_781_083_007;
    const maxOracleAgeSec = 604_800;
    const staleRoundData = encodeLatestRoundData({
      roundId: 44n,
      answer: 106_766_689n,
      startedAt: BigInt(updatedAt),
      updatedAt: BigInt(updatedAt),
      answeredInRound: 44n,
    });

    vi.mocked(helpers.fetchOnchainUint256).mockImplementation(async (opts) => {
      if (opts.contract === ORACLE_ADDRESS && opts.data === DECIMALS_SELECTOR) return 8n;
      if (opts.contract === TOKEN_ADDRESS && opts.data === DECIMALS_SELECTOR) return 18n;
      if (opts.contract === TOKEN_ADDRESS && opts.data === TOTAL_SUPPLY_SELECTOR) return 1_000_000_000_000_000_000n;
      return null;
    });
    vi.mocked(helpers.fetchOnchainRawCall).mockImplementation(async (opts) => {
      if (opts.contract === ORACLE_ADDRESS && opts.data === LATEST_ROUND_DATA_SELECTOR) return staleRoundData;
      return null;
    });

    const config = makeChainlinkNavConfig({
      params: {
        assetLabel: "Re7-managed DeFi yield strategy NAV",
        assetRisk: "high",
        maxOracleAgeSec,
      },
    });

    await expect(fetchChainlinkNavCore(
      {} as never,
      config as never,
      new AbortController().signal,
      { nowSec: updatedAt + maxOracleAgeSec + 1 },
    )).rejects.toThrow(`chainlink-nav: oracle data is stale (${maxOracleAgeSec + 1}s > ${maxOracleAgeSec}s)`);
  });

  it("reads getPriceData directly and marks freshness verified", async () => {
    const helpers = await import("../helpers");
    const { fetchChainlinkNavCore } = await import("../chainlink-nav-core");
    const updatedAt = 1_775_684_339;
    const rawPriceData = "0x"
      + "00000000000000000000000000000000000000000000000639e961576659e000"
      + "0000000000000000000000000000000000000000000000000000000069d6caf3";

    vi.mocked(helpers.fetchOnchainUint256).mockImplementation(async (opts) => {
      if (opts.data === "0x313ce567") return 18n; // decimals()
      if (opts.data === "0x18160ddd") return 500_000_000_000_000_000_000n; // totalSupply()
      return null;
    });
    vi.mocked(helpers.fetchOnchainRawCall).mockImplementation(async (opts) => {
      if (opts.data === "0xa4a28168" && opts.contract === ORACLE_ADDRESS) {
        return rawPriceData;
      }
      return null;
    });

    const config = makeChainlinkNavConfig({
      params: {
        assetLabel: "Ondo T-Bills",
        assetRisk: "very-low",
        oracleMethod: "getPriceData",
      },
    });

    const result = await fetchChainlinkNavCore(
      {} as never,
      config as never,
      new AbortController().signal,
      { nowSec: updatedAt + 60 },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      oracleTimestampSource: "ondo-price-data",
      oracleUpdatedAt: updatedAt,
      sourceTimestamp: updatedAt,
    });
    expect(result.metadata?.navPerToken).toBe("114.853438");
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-bound",
      freshnessKind: "verified-source-timestamp",
    });
    expect(helpers.fetchOnchainRawCall).toHaveBeenCalledTimes(1);
    expect(helpers.fetchOnchainUint256).toHaveBeenCalledTimes(2);
  });

  it("emits opt-in OUSG InstantManager redemption capacity from the pinned default route", async () => {
    const helpers = await import("../helpers");
    const { fetchChainlinkNavCore } = await import("../chainlink-nav-core");
    const updatedAt = 1_775_684_339;
    const rawPriceData = "0x"
      + "00000000000000000000000000000000000000000000000639e961576659e000"
      + "0000000000000000000000000000000000000000000000000000000069d6caf3";

    vi.mocked(helpers.fetchOnchainUint256).mockImplementation(async (opts) => {
      if (opts.data === DECIMALS_SELECTOR) return 18n;
      if (opts.data === TOTAL_SUPPLY_SELECTOR) return 500_000_000_000_000_000_000n;
      if (opts.contract === MANAGER_ADDRESS && opts.data === "0x8f8eb812") {
        return 4_999_990_000_000_000_000_000n;
      }
      if (opts.contract === ROUTER_ADDRESS && opts.data.startsWith("0x6cde714a")) {
        return 8_499_999_997_683n;
      }
      return null;
    });
    vi.mocked(helpers.fetchOnchainRawCall).mockImplementation(async (opts) => {
      if (opts.contract === ORACLE_ADDRESS && opts.data === "0xa4a28168") return rawPriceData;
      if (opts.contract === MANAGER_ADDRESS && opts.data === "0x8f4f9613") return encodeAddressResult(ROUTER_ADDRESS);
      if (opts.contract === ROUTER_ADDRESS && opts.data.startsWith("0x2021065d")) {
        return encodeAddressResult(SOURCE_ADDRESS);
      }
      if (opts.contract === MANAGER_ADDRESS && opts.data === "0xb235d468") return encodeUint256Result(0n);
      if (opts.contract === MANAGER_ADDRESS && opts.data.startsWith("0x884a0501")) return encodeUint256Result(1n);
      return null;
    });

    const result = await fetchChainlinkNavCore(
      {} as never,
      makeChainlinkNavConfig({
        params: {
          assetLabel: "Ondo T-Bills",
          assetRisk: "very-low",
          oracleMethod: "getPriceData",
          redemptionCapacity: {
            managerAddress: MANAGER_ADDRESS,
            usdcAddress: USDC_ADDRESS,
            routerAddress: ROUTER_ADDRESS,
            sourceAddress: SOURCE_ADDRESS,
            pauseSelector: "0xb235d468",
          },
        },
      }) as never,
      new AbortController().signal,
      { nowSec: updatedAt + 60 },
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 8_499_999.997683,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "whitelisted-primary",
      settlementDelaySec: 0,
      minRedeemUsd: 4_999.99,
    });
  });

  it("keeps NAV telemetry when the opt-in redemption probe fails closed", async () => {
    const helpers = await import("../helpers");
    const { fetchChainlinkNavCore } = await import("../chainlink-nav-core");
    const updatedAt = 1_775_684_339;
    const rawPriceData = "0x"
      + "00000000000000000000000000000000000000000000000639e961576659e000"
      + "0000000000000000000000000000000000000000000000000000000069d6caf3";

    vi.mocked(helpers.fetchOnchainUint256).mockImplementation(async (opts) => {
      if (opts.data === DECIMALS_SELECTOR) return 18n;
      if (opts.data === TOTAL_SUPPLY_SELECTOR) return 500_000_000_000_000_000_000n;
      if (opts.contract === MANAGER_ADDRESS && opts.data === "0x8f8eb812") return 5_000n * 10n ** 18n;
      if (opts.contract === ROUTER_ADDRESS && opts.data.startsWith("0x6cde714a")) return 8_500_000n * 10n ** 6n;
      return null;
    });
    vi.mocked(helpers.fetchOnchainRawCall).mockImplementation(async (opts) => {
      if (opts.contract === ORACLE_ADDRESS && opts.data === "0xa4a28168") return rawPriceData;
      if (opts.contract === MANAGER_ADDRESS && opts.data === "0x8f4f9613") return encodeAddressResult(ROUTER_ADDRESS);
      if (opts.contract === ROUTER_ADDRESS && opts.data.startsWith("0x2021065d")) {
        return encodeAddressResult(SOURCE_ADDRESS);
      }
      if (opts.contract === MANAGER_ADDRESS && opts.data.startsWith("0x884a0501")) return encodeUint256Result(1n);
      return null;
    });

    const result = await fetchChainlinkNavCore(
      {} as never,
      makeChainlinkNavConfig({
        params: {
          assetLabel: "Ondo T-Bills",
          assetRisk: "very-low",
          oracleMethod: "getPriceData",
          redemptionCapacity: {
            managerAddress: MANAGER_ADDRESS,
            usdcAddress: USDC_ADDRESS,
            routerAddress: ROUTER_ADDRESS,
            sourceAddress: SOURCE_ADDRESS,
            pauseSelector: "0xb235d468",
          },
        },
      }) as never,
      new AbortController().signal,
      { nowSec: updatedAt + 60 },
    );

    expect(result.metadata?.navPerToken).toBe("114.853438");
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("emits chainlink-nav-wrapper-oracle-malformed when the wrapper oracle returns garbage", async () => {
    const helpers = await import("../helpers");
    const { fetchChainlinkNavCore } = await import("../chainlink-nav-core");

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

    const config = makeChainlinkNavConfig({
      semantics: "collateral-mix",
      params: {
        assetLabel: "Ondo T-Bills",
        assetRisk: "very-low",
        oracleMethod: "getAssetPrice",
      },
    });

    const result = await fetchChainlinkNavCore(
      {} as never,
      config as never,
      new AbortController().signal,
    );

    expect(result.warnings?.some((w) => w.code === "chainlink-nav-wrapper-oracle-malformed")).toBe(true);
    // freshness falls through to unverified (no valid wrapper timestamp)
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });
});
