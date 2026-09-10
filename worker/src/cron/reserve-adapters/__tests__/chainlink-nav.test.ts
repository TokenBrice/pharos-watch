import { describe, it, expect } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../../lib/evm-selectors";
import {
  adaptChainlinkNavResponse,
  parseOndoPriceData,
  type ChainlinkNavParams,
} from "../chainlink-nav-core";
import { installAdapterNetwork, runAdapter, type AdapterNetwork, type AdapterNetworkSpec, type AdapterRpcValue } from "./reserve-adapter.test-support";

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
      navScope: "native-fund-share",
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

const NAV_COIN = {
  id: "chainlink-nav-test",
  name: "Chainlink NAV Test",
  symbol: "NAV",
} as unknown as StablecoinMeta;

function navNetwork(overrides: {
  tokenDecimals?: bigint;
  totalSupply?: bigint;
  oracleDecimals?: bigint;
  latestRoundData?: `0x${string}`;
  priceData?: `0x${string}`;
  assetPrice?: bigint;
  wrapperAddress?: string;
  redemption?: boolean;
  pauseValue?: string;
} = {}): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {
    [`${TOKEN_ADDRESS}:${DECIMALS_SELECTOR}`]: overrides.tokenDecimals ?? 18n,
    [`${TOKEN_ADDRESS}:${TOTAL_SUPPLY_SELECTOR}`]: overrides.totalSupply ?? 500_000_000_000_000_000_000n,
    [`${ORACLE_ADDRESS}:${DECIMALS_SELECTOR}`]: overrides.oracleDecimals ?? 18n,
    [`${ORACLE_ADDRESS}:${LATEST_ROUND_DATA_SELECTOR}`]: overrides.latestRoundData
      ?? encodeLatestRoundData({
        roundId: 44n,
        answer: 106_766_689n,
        startedAt: 1_781_083_007n,
        updatedAt: 1_781_083_007n,
        answeredInRound: 44n,
      }),
    [`${ORACLE_ADDRESS}:0xa4a28168`]: overrides.priceData
      ?? "0x"
        + "00000000000000000000000000000000000000000000000639e961576659e000"
        + "0000000000000000000000000000000000000000000000000000000069d6caf3",
    [`${ORACLE_ADDRESS}:0xb3596f07`]: overrides.assetPrice ?? 1_000_000_000_000_000_000n,
  };
  if (overrides.wrapperAddress) {
    rpc[`${ORACLE_ADDRESS}:0xeca6f018`] = encodeAddressResult(overrides.wrapperAddress);
    rpc[`${overrides.wrapperAddress}:0xa4a28168`] = "0xdeadbeef";
  }
  if (overrides.redemption) {
    rpc[`${MANAGER_ADDRESS}:0x8f4f9613`] = encodeAddressResult(ROUTER_ADDRESS);
    rpc[`${ROUTER_ADDRESS}:0x2021065d`] = encodeAddressResult(SOURCE_ADDRESS);
    rpc[`${MANAGER_ADDRESS}:0xb235d468`] = overrides.pauseValue ?? encodeUint256Result(0n);
    rpc[`${MANAGER_ADDRESS}:0x884a0501`] = encodeUint256Result(1n);
    rpc[`${MANAGER_ADDRESS}:0x8f8eb812`] = 4_999_990_000_000_000_000_000n;
    rpc[`${ROUTER_ADDRESS}:0x6cde714a`] = 8_499_999_997_683n;
  }
  return { rpc };
}

function runNav(
  config: LiveReservesConfig,
  network: AdapterNetworkSpec | AdapterNetwork,
  nowSec: number,
) {
  return runAdapter("chainlink-nav", { ...NAV_COIN, liveReservesConfig: config }, {
    network,
    nowSec,
  });
}

describe("adaptChainlinkNavResponse", () => {
  const params: ChainlinkNavParams = {
    navScope: "native-fund-share",
    oracleAddress: "0x74f2199AEb743f68f05943e5715A33EaF2b61f53",
    tokenAddress: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b",
    assetLabel: "U.S. Treasury Bills",
    assetRisk: "very-low",
    sourceKey: "chainlink-nav:test",
  };

  it("retains native fund-share exposure without a scoring degradation", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000n, navDecimals: 6, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 384n, updatedAt: 1773405239 },
      params,
    );
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.warnings?.filter((warning) => warning.effect === "degraded") ?? []).toEqual([]);
  });

  it("keeps portfolio NAV visible but degrades unverified composition", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000n, navDecimals: 6, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 384n, updatedAt: 1773405239 },
      { ...params, navScope: "portfolio" },
    );
    expect(result.slices[0].pct).toBe(100);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "nav-portfolio-composition-unverified", effect: "degraded" }),
    ]));
  });

  it("reports NAV and observed token supply with timestamped valuation evidence", () => {
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
  it("throws when standard Chainlink NAV round data exceeds the configured freshness window", async () => {
    const updatedAt = 1_781_083_007;
    const maxOracleAgeSec = 604_800;
    const network = navNetwork({
      oracleDecimals: 8n,
      tokenDecimals: 18n,
      totalSupply: 1_000_000_000_000_000_000n,
      latestRoundData: encodeLatestRoundData({
        roundId: 44n,
        answer: 106_766_689n,
        startedAt: BigInt(updatedAt),
        updatedAt: BigInt(updatedAt),
        answeredInRound: 44n,
      }),
    });

    const installed = installAdapterNetwork(network);
    await expect(runNav(
      makeChainlinkNavConfig({
        params: {
          assetLabel: "Re7-managed DeFi yield strategy NAV",
          assetRisk: "high",
          maxOracleAgeSec,
        },
      }),
      installed,
      updatedAt + maxOracleAgeSec + 1,
    )).rejects.toThrow(`chainlink-nav: oracle data is stale (${maxOracleAgeSec + 1}s > ${maxOracleAgeSec}s)`);

    expect(installed.rpcCalls.filter((call) => call.viaMulticall).map((call) => ({
      contract: call.contract,
      data: call.data,
    }))).toEqual([
      { contract: TOKEN_ADDRESS.toLowerCase(), data: DECIMALS_SELECTOR },
      { contract: TOKEN_ADDRESS.toLowerCase(), data: TOTAL_SUPPLY_SELECTOR },
      { contract: ORACLE_ADDRESS.toLowerCase(), data: DECIMALS_SELECTOR },
      { contract: ORACLE_ADDRESS.toLowerCase(), data: LATEST_ROUND_DATA_SELECTOR },
    ]);
  });

  it("reads getPriceData directly and marks freshness verified", async () => {
    const updatedAt = 1_775_684_339;
    const rawPriceData = "0x"
      + "00000000000000000000000000000000000000000000000639e961576659e000"
      + "0000000000000000000000000000000000000000000000000000000069d6caf3" as `0x${string}`;
    const network = navNetwork({ priceData: rawPriceData });

    const { result, network: installed } = await runNav(
      makeChainlinkNavConfig({
        params: {
          assetLabel: "Ondo T-Bills",
          assetRisk: "very-low",
          oracleMethod: "getPriceData",
        },
      }),
      network,
      updatedAt + 60,
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
    expect(installed.rpcCalls.filter((call) => !call.viaMulticall)).toHaveLength(3);
  });

  it("emits opt-in OUSG InstantManager redemption capacity from the pinned default route", async () => {
    const updatedAt = 1_775_684_339;
    const rawPriceData = "0x"
      + "00000000000000000000000000000000000000000000000639e961576659e000"
      + "0000000000000000000000000000000000000000000000000000000069d6caf3" as `0x${string}`;
    const network = navNetwork({ priceData: rawPriceData, redemption: true });

    const { result } = await runNav(
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
      }),
      network,
      updatedAt + 60,
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
    const updatedAt = 1_775_684_339;
    const rawPriceData = "0x"
      + "00000000000000000000000000000000000000000000000639e961576659e000"
      + "0000000000000000000000000000000000000000000000000000000069d6caf3" as `0x${string}`;
    const network = navNetwork({
      priceData: rawPriceData,
      redemption: true,
      pauseValue: encodeUint256Result(2n),
    });

    const { result } = await runNav(
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
      }),
      network,
      updatedAt + 60,
    );

    expect(result.metadata?.navPerToken).toBe("114.853438");
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("emits chainlink-nav-wrapper-oracle-malformed when the wrapper oracle returns garbage", async () => {
    const network = navNetwork({
      tokenDecimals: 6n,
      totalSupply: 500_000_000n,
      assetPrice: 1_000_000_000_000_000_000n,
      wrapperAddress: WRAPPER_ADDRESS,
    });
    const { result } = await runNav(
      makeChainlinkNavConfig({
        semantics: "collateral-mix",
        params: {
          navScope: "portfolio",
          assetLabel: "Ondo T-Bills",
          assetRisk: "very-low",
          oracleMethod: "getAssetPrice",
        },
      }),
      network,
      1_775_684_399,
    );

    expect(result.warnings?.some((w) => w.code === "chainlink-nav-wrapper-oracle-malformed")).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "nav-portfolio-composition-unverified", effect: "degraded" }),
    ]));
    // freshness falls through to unverified (no valid wrapper timestamp)
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });
});
