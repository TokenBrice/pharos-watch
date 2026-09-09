import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonAdapterInput: vi.fn(),
    fetchOnchainMulticall3: vi.fn(),
    fetchErc20Balance: vi.fn(),
    fetchErc20TotalSupply: vi.fn(),
  };
});

import {
  adaptKrwqCustodian,
  fetchKrwqCustodianReserves,
  type KrwqCustodianPayload,
  type KrwqOnchainBalances,
  type KrwqSupplyAggregate,
} from "../krwq-custodian";
import { fetchErc20Balance, fetchErc20TotalSupply, fetchJsonAdapterInput, fetchOnchainMulticall3 } from "../helpers";
import { getReserveAdapter } from "../index";
import { expectValidAdapterOutput, mockedReserveHelper } from "./reserve-adapter.test-support";

let signal: AbortSignal;

const USDC_ETHEREUM = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const FRXUSD_ETHEREUM = "0xcacd6fd266af91b8aed52accc382b4e165586e29";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const PAYLOAD: KrwqCustodianPayload = {
  usdc: {
    totalAssets: 90102.08,
    totalAssetsRaw: "90102080832",
    custodianAddress: "0x5573b8db24043beE020C36Ee0Df32694DFFeF04C",
  },
  frxusd: {
    totalAssets: 482631.87,
    totalAssetsRaw: "482631869316796940855261",
    custodianAddress: "0x7e88aC6A9C2DaD21feA4dE6b54C764cA4D99C05D",
  },
  treasury: {
    totalAssets: 105708.96,
    totalAssetsRaw: "105708960000",
    treasuryAddress: "0xA3E0B562C6FD7D6F570B2afC2Cc4e240226D8B54",
  },
  timestamp: "2026-09-09T15:57:21.603Z",
};

const ONCHAIN_MATCH: KrwqOnchainBalances = {
  usdc: 90102080832n,
  frxusd: 482631869316796940855261n,
  treasury: 105708960000n,
};

const SUPPLY_USD = 582_354;
const SUPPLY: KrwqSupplyAggregate = {
  contributions: [
    { chain: "ethereum", tokenAddress: "0xabc", raw: BigInt(SUPPLY_USD) * 10n ** 18n, decimals: 18 },
  ],
  omittedNonEvmChains: [],
  omittedReadFailureChains: [],
};

const TOTAL_RESERVE_USD = 90102.08 + 482631.87 + 105708.96;

function makeCoin(): StablecoinMeta {
  return {
    id: "krwq-iq",
    symbol: "KRWQ",
    contracts: [
      { chain: "ethereum", address: "0xc00db6b41473d065027f5ed6fada20fde75f142e", decimals: 18 },
      { chain: "base", address: "0x370923d39f139c64813f173a1bf0b4f9ba36a24f", decimals: 18 },
    ],
  } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "krwq-custodian",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "http-json", url: "https://www.krwq.cash/api/custodian-assets" },
    },
  } as unknown as LiveReservesConfig;
}

function toBalanceHex(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  signal = new AbortController().signal;
});

describe("adaptKrwqCustodian", () => {
  it("maps the three custodian legs and verifies an exact on-chain match", () => {
    const result = adaptKrwqCustodian(PAYLOAD, ONCHAIN_MATCH, SUPPLY);

    expect(result.warnings).toBeUndefined();
    expect(result.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "krwq-custodian:usdc", name: "USDC custodian reserves", coinId: "usdc-circle", risk: "low" }),
      expect.objectContaining({ name: "frxUSD custodian reserves", coinId: "frxusd-frax", risk: "low" }),
      expect.objectContaining({ name: "Treasury USDC (Korean Treasury Bond transition)", coinId: "usdc-circle", risk: "low" }),
    ]));
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-09-09T15:57:21.603Z") / 1000),
      freshnessMode: "verified",
      totalReserveUsd: expect.closeTo(TOTAL_RESERVE_USD, 5),
    });
    expect(result.metadata?.supplyUsd).toBeCloseTo(SUPPLY_USD, 6);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(TOTAL_RESERVE_USD / SUPPLY_USD, 6);
    expectValidAdapterOutput("krwq-custodian", result);
  });

  it("degrades and keeps the issuer value when an on-chain balance diverges", () => {
    const result = adaptKrwqCustodian(PAYLOAD, { ...ONCHAIN_MATCH, usdc: 123n }, SUPPLY);

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "krwq-onchain-mismatch", effect: "degraded" }),
    ]));
    expect(result.slices.find((slice) => slice.name === "USDC custodian reserves")).toBeDefined();
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL_RESERVE_USD, 5);
  });

  it("degrades and keeps the issuer value when the frxUSD balanceOf read is null", () => {
    const result = adaptKrwqCustodian(PAYLOAD, { ...ONCHAIN_MATCH, frxusd: null }, SUPPLY);

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "krwq-onchain-read-failed", effect: "degraded" }),
    ]));
    expect(result.slices.find((slice) => slice.name === "frxUSD custodian reserves")).toBeDefined();
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL_RESERVE_USD, 5);
  });

  it("throws when the payload timestamp is missing", () => {
    expect(() => adaptKrwqCustodian({ ...PAYLOAD, timestamp: undefined }, ONCHAIN_MATCH, SUPPLY))
      .toThrow("unreadable timestamp");
  });

  it("omits the collateralization ratio when no supply is readable", () => {
    const result = adaptKrwqCustodian(PAYLOAD, ONCHAIN_MATCH, {
      contributions: [],
      omittedNonEvmChains: [],
      omittedReadFailureChains: [],
    });

    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.supplyUsd).toBeUndefined();
  });
});

describe("fetchKrwqCustodianReserves", () => {
  it("reads both Ethereum legs in one Multicall3 and the Base treasury separately", async () => {
    mockedReserveHelper(fetchJsonAdapterInput).mockResolvedValue(PAYLOAD);
    mockedReserveHelper(fetchOnchainMulticall3).mockResolvedValue([
      { label: "usdc-balance", success: true, returnData: toBalanceHex(90102080832n) },
      { label: "frxusd-balance", success: true, returnData: toBalanceHex(482631869316796940855261n) },
    ]);
    mockedReserveHelper(fetchErc20Balance).mockResolvedValue(105708960000n);
    mockedReserveHelper(fetchErc20TotalSupply).mockResolvedValue(BigInt(SUPPLY_USD) * 10n ** 18n);

    const result = await fetchKrwqCustodianReserves(makeCoin(), makeConfig(), signal);

    expect(fetchOnchainMulticall3).toHaveBeenCalledWith(expect.objectContaining({
      chain: "ethereum",
      calls: [
        { label: "usdc-balance", contract: USDC_ETHEREUM, data: expect.any(String), allowFailure: true },
        { label: "frxusd-balance", contract: FRXUSD_ETHEREUM, data: expect.any(String), allowFailure: true },
      ],
    }));
    expect(fetchErc20Balance).toHaveBeenCalledWith(
      { kind: "onchain-evm", chain: "base", rpcMode: "public-rpc" },
      USDC_BASE,
      "0xA3E0B562C6FD7D6F570B2afC2Cc4e240226D8B54",
      signal,
      undefined,
    );
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toHaveLength(3);
  });

  it("propagates an error when the endpoint request fails", async () => {
    mockedReserveHelper(fetchJsonAdapterInput).mockRejectedValue(
      new Error("HTTP 500 for https://www.krwq.cash/api/custodian-assets"),
    );

    await expect(fetchKrwqCustodianReserves(makeCoin(), makeConfig(), signal)).rejects.toThrow("HTTP 500");
  });
});

describe("registry", () => {
  it("resolves the krwq-custodian adapter", () => {
    expect(getReserveAdapter("krwq-custodian")).not.toBeNull();
  });
});
