import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  adaptKrwqCustodian,
  type KrwqCustodianPayload,
  type KrwqOnchainBalances,
  type KrwqSupplyAggregate,
} from "../krwq-custodian";
import { getReserveAdapter } from "../index";
import { expectValidAdapterOutput, runAdapter } from "./reserve-adapter.test-support";


const USDC_ETHEREUM = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const FRXUSD_ETHEREUM = "0xcacd6fd266af91b8aed52accc382b4e165586e29";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const KRWQ_URL = "https://www.krwq.cash/api/custodian-assets";
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
    liveReservesConfig: makeConfig(),
  } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "krwq-custodian",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "http-json", url: KRWQ_URL },
    },
  } as unknown as LiveReservesConfig;
}


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
  function krwqNetwork(payload: unknown = PAYLOAD) {
    return {
      json: { [KRWQ_URL]: payload },
      rpc: {
        [`ethereum:${USDC_ETHEREUM}:balanceOf(address)`]: 90102080832n,
        [`ethereum:${FRXUSD_ETHEREUM}:balanceOf(address)`]: 482631869316796940855261n,
        [`base:${USDC_BASE}:balanceOf(address)`]: 105708960000n,
        "totalSupply()": BigInt(SUPPLY_USD) * 10n ** 18n,
      },
    };
  }

  it("reads issuer data and on-chain legs through the shared network harness", async () => {
    const { result, network } = await runAdapter("krwq-custodian", makeCoin(), {
      network: krwqNetwork(),
      nowSec: Math.floor(Date.parse("2026-09-09T16:00:00Z") / 1000),
    });

    expect(network.requests.map((request) => request.url)).toContain(KRWQ_URL);
    expect(network.rpcCalls.some((call) => call.viaMulticall && call.chain === "ethereum")).toBe(true);
    expect(network.rpcCalls.some((call) => !call.viaMulticall && call.chain === "base")).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toHaveLength(3);
  });

  it("propagates an endpoint failure", async () => {
    await expect(runAdapter("krwq-custodian", makeCoin(), {
      network: krwqNetwork({ status: 500, body: "upstream unavailable" }),
      nowSec: Math.floor(Date.parse("2026-09-09T16:00:00Z") / 1000),
    })).rejects.toThrow(/500/);
  });

  it("fails closed when an issuer leg is dropped from the upstream payload", async () => {
    await expect(runAdapter("krwq-custodian", makeCoin(), {
      network: krwqNetwork({ ...PAYLOAD, frxusd: undefined }),
      nowSec: Math.floor(Date.parse("2026-09-09T16:00:00Z") / 1000),
      validate: false,
    })).rejects.toThrow(/missing frxusd leg/);
  });
});

describe("registry", () => {
  it("resolves the krwq-custodian adapter", () => {
    expect(getReserveAdapter("krwq-custodian")).not.toBeNull();
  });
});
