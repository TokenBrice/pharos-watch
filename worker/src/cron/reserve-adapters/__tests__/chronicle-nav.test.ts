import { describe, expect, it } from "vitest";
import { adaptChronicleNavResponse, decodeChronicleReadWithAge } from "../chronicle-nav";
import {
  expectWarningEffect,
  expectWarnings,
  runAdapter,
} from "./reserve-adapter.test-support";

// ---------------------------------------------------------------------------
// Catalog identities (probed live 2026-09-09)
// ---------------------------------------------------------------------------

const BUIDL_CONSUMER = "0x2d6db2116ad7a6e203e72c8dccfff23f5315b0dd";
const BUIDL_TOKEN = "0x7712c34205737192402172409a8f7ccef8aa2aec";
const BUIDL_I_TOKEN = "0x6a9da2d710bb9b700acde7cb81f10f1ff8c89041";
const NOW_SEC = 1_786_700_000;

// Chronicle's 2026-09-09 per-chain supply table (dashboard), minus the
// non-EVM Solana/Aptos rows the adapter omits by design.
const BUIDL_CHAIN_SUPPLIES: Record<string, bigint> = {
  [`ethereum:${BUIDL_TOKEN}`]: 212_032_317_000000n,
  [`ethereum:${BUIDL_I_TOKEN}`]: 674_037_423_700100n,
  "bsc:0x2d5bdc96d9c8aabbdb38c9a27398513e7e5ef84f": 136_325_814_000000n,
  "optimism:0xa1cdab15bba75a80df4089cafba013e376957cf5": 26_422_103_000000n,
  "arbitrum:0xa6525ae43edcd03dc08e775774dcabd3bb925872": 8_561_075_000000n,
  "avalanche:0x53fc82f14f009009b440a706e31c9021e1196a2f": 564_502_370_000000n,
  "polygon:0x2893ef551b6dd69f661ac00f11d93e5dc5dc0e99": 4_525_095_000000n,
};

const BUIDL_EVM_SUPPLY_RAW = Object.values(BUIDL_CHAIN_SUPPLIES).reduce((sum, value) => sum + value, 0n);

function encodeReadWithAge(value: bigint, age: number): `0x${string}` {
  const word = (wordValue: bigint) => wordValue.toString(16).padStart(64, "0");
  return `0x${word(value)}${word(BigInt(age))}` as `0x${string}`;
}

function buidlNetwork(overrides: { value?: bigint; age?: number; chains?: Record<string, bigint | null> } = {}) {
  const rpc: Record<string, bigint | string | null> = {
    [`ethereum:${BUIDL_CONSUMER}:0x393e5ede`]: encodeReadWithAge(
      overrides.value ?? 1_000_000_000_000_000_000n,
      overrides.age ?? NOW_SEC - 60,
    ),
    [`ethereum:${BUIDL_TOKEN}:0x313ce567`]: 6n,
    ...Object.fromEntries(
      Object.entries(overrides.chains ?? BUIDL_CHAIN_SUPPLIES).map(([key, value]) => [`${key}:0x18160ddd`, value]),
    ),
  };
  return { rpc };
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// BUIDL binding (real catalog config through the harness)
// ---------------------------------------------------------------------------

describe("chronicle-nav BUIDL binding", () => {
  it("reads the VAO NAV and aggregates totalSupply across every EVM deployment", async () => {
    const { result } = await runAdapter("chronicle-nav", "buidl-blackrock", {
      network: buidlNetwork(),
      nowSec: NOW_SEC,
    });

    expect(result.slices).toEqual([
      {
        sourceKey: `chronicle-nav:token:${BUIDL_TOKEN}`,
        name: "BlackRock BUIDL fund shares",
        pct: 100,
        risk: "low",
      },
    ]);
    expect(result.metadata).toMatchObject({
      navPerToken: "1",
      totalSupplyRaw: BUIDL_EVM_SUPPLY_RAW.toString(),
      totalSupplyFormatted: (Number(BUIDL_EVM_SUPPLY_RAW) / 1e6).toString(),
      navDecimals: 18,
      tokenDecimals: 6,
      oracleUpdatedAt: NOW_SEC - 60,
      oracleTimestampSource: "chronicle-readWithAge",
      sourceTimestamp: NOW_SEC - 60,
      freshnessMode: "verified",
      supplyReadComplete: true,
      supplyCoverageComplete: false,
    });
    expect(result.metadata?.supplyContributions).toHaveLength(7);
    // Non-EVM deployments (solana, aptos) are omitted by design and surfaced
    // as an info warning, never as a silent completeness claim.
    expectWarnings(result, ["por-supply-chain-omitted"]);
    expectWarningEffect(result, "por-supply-chain-omitted", "info");
  });

  it("degrades a portfolio-scoped NAV instead of claiming fund-share verification", async () => {
    const { result } = await runAdapter("chronicle-nav", "buidl-blackrock", {
      network: buidlNetwork(),
      nowSec: NOW_SEC,
      params: { navScope: "portfolio" },
    });

    expectWarningEffect(result, "nav-portfolio-composition-unverified", "degraded");
    expect(result.metadata?.supplyCoverageComplete).toBe(false);
  });

  it("degrades with a partial supply when one chain's totalSupply read fails", async () => {
    const { result } = await runAdapter("chronicle-nav", "buidl-blackrock", {
      network: buidlNetwork({ chains: { ...BUIDL_CHAIN_SUPPLIES, "bsc:0x2d5bdc96d9c8aabbdb38c9a27398513e7e5ef84f": null } }),
      nowSec: NOW_SEC,
    });

    expect(result.metadata?.supplyReadComplete).toBe(false);
    expect(result.metadata?.totalSupplyRaw).toBe(
      (BUIDL_EVM_SUPPLY_RAW - 136_325_814_000000n).toString(),
    );
    expectWarningEffect(result, "partial-supply-read-failure", "degraded");
  });

  it("rejects a stale VAO age", async () => {
    await expect(runAdapter("chronicle-nav", "buidl-blackrock", {
      network: buidlNetwork({ age: NOW_SEC - 345_601 }),
      nowSec: NOW_SEC,
    })).rejects.toThrow(/stale/);
  });

  it("fails closed when every chain's totalSupply read fails", async () => {
    await expect(runAdapter("chronicle-nav", "buidl-blackrock", {
      network: buidlNetwork({ chains: Object.fromEntries(Object.keys(BUIDL_CHAIN_SUPPLIES).map((key) => [key, null])) }),
      nowSec: NOW_SEC,
    })).rejects.toThrow(/failed on all/);
  });
});

// ---------------------------------------------------------------------------
// Existing bindings keep their native-fund-share admission
// ---------------------------------------------------------------------------

describe("chronicle-nav ACRDX binding", () => {
  it("aggregates the coin's EVM deployments and omits the Solana deployment with an info warning", async () => {
    const acrdx = { network: { rpc: {
      "ethereum:0x9a3bf392f86acd1b1ec07d026b326302eaed7488:0x393e5ede": encodeReadWithAge(1_027_991_334_000_000_000n, NOW_SEC - 60),
      "ethereum:0x9477724bb54ad5417de8baff29e59df3fb4da74f:0x313ce567": 18n,
      "ethereum:0x9477724bb54ad5417de8baff29e59df3fb4da74f:0x18160ddd": 100_000_000_000_000_000_000n,
      "plume:0x9477724bb54ad5417de8baff29e59df3fb4da74f:0x18160ddd": 20_000_000_000_000_000_000n,
      "monad:0x2fabf1c784b8583d63c00c5c9c0377d8cf1a3245:0x18160ddd": 5_000_000_000_000_000_000n,
      "base:0x9477724bb54ad5417de8baff29e59df3fb4da74f:0x18160ddd": 7_000_000_000_000_000_000n,
      "optimism:0x2fabf1c784b8583d63c00c5c9c0377d8cf1a3245:0x18160ddd": 3_000_000_000_000_000_000n,
    } } };

    const { result } = await runAdapter("chronicle-nav", "acrdx-anemoy-apollo", { ...acrdx, nowSec: NOW_SEC });

    expect(result.slices[0]).toMatchObject({
      sourceKey: "chronicle-nav:token:0x9477724bb54ad5417de8baff29e59df3fb4da74f",
      pct: 100,
    });
    expect(result.metadata?.supplyContributions).toHaveLength(5);
    expect(result.metadata?.supplyCoverageComplete).toBe(false);
    expectWarnings(result, ["por-supply-chain-omitted"]);
    expectWarningEffect(result, "por-supply-chain-omitted", "info");
  });
});

// ---------------------------------------------------------------------------
// Pure adaptation boundaries
// ---------------------------------------------------------------------------

describe("adaptChronicleNavResponse", () => {
  it("rejects a zero NAV value", () => {
    expect(() => adaptChronicleNavResponse(
      {
        navPerToken: 0n,
        supply: {
          contributions: [{ chain: "ethereum", tokenAddress: BUIDL_TOKEN, raw: 1_000_000n, decimals: 6 }],
          omittedNonEvmChains: [],
          omittedNoRpcChains: [],
          omittedReadFailureChains: [],
        },
        tokenDecimals: 6,
        updatedAt: NOW_SEC,
      },
      {
        navScope: "native-fund-share",
        consumerAddress: BUIDL_CONSUMER,
        tokenAddress: BUIDL_TOKEN,
        assetLabel: "BlackRock BUIDL fund shares",
        assetRisk: "low",
      },
    )).toThrow("zero or negative NAV");
  });

  it("degrades a mixed-decimals aggregate instead of publishing a meaningless raw total", () => {
    const result = adaptChronicleNavResponse(
      {
        navPerToken: 1_000_000_000_000_000_000n,
        supply: {
          contributions: [
            { chain: "ethereum", tokenAddress: BUIDL_TOKEN, raw: 1_000_000n, decimals: 6 },
            { chain: "bsc", tokenAddress: BUIDL_TOKEN, raw: 1_000_000n, decimals: 18 },
          ],
          omittedNonEvmChains: [],
          omittedNoRpcChains: [],
          omittedReadFailureChains: [],
        },
        tokenDecimals: 6,
        updatedAt: NOW_SEC,
      },
      {
        navScope: "native-fund-share",
        consumerAddress: BUIDL_CONSUMER,
        tokenAddress: BUIDL_TOKEN,
        assetLabel: "BlackRock BUIDL fund shares",
        assetRisk: "low",
      },
    );

    expectWarningEffect(result, "mixed-supply-decimals", "degraded");
  });
});
