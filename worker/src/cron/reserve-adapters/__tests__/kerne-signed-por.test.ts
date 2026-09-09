import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { hexToBytes, keccak256 } from "viem/utils";
import { privateKeyToAccount } from "viem/accounts";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonAdapterInput: vi.fn(),
    fetchOnchainMulticall3: vi.fn(),
  };
});

import {
  adaptKerneSignedPor,
  fetchKerneSignedPorReserves,
} from "../kerne-signed-por";
import { fetchJsonAdapterInput, fetchOnchainMulticall3 } from "../helpers";
import { getReserveAdapter } from "../index";
import { expectValidAdapterOutput, mockedReserveHelper } from "./reserve-adapter.test-support";

let signal: AbortSignal;

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const SIGNER = account.address;

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PSMS = [
  "0xaBDE1138aa1Ce88d1dF06422C0c3b05D70569803",
  "0x07eBb486e11BD217e6085eb5ab663e4517595993",
  "0xFf3025ec18e301855aB0f36Ec6ECa115a29A5Fbc",
];

const TIMESTAMP = 1_788_977_221;
const PSM_USDC_RESERVE = 1110.888006;
const OUTSTANDING_KUSD = 1109.707154;

function eip191DigestHash(digestHex: string): `0x${string}` {
  const digest = hexToBytes(digestHex as `0x${string}`);
  const prefix = new TextEncoder().encode(`\u0019Ethereum Signed Message:\n${digest.length}`);
  const message = new Uint8Array(prefix.length + digest.length);
  message.set(prefix, 0);
  message.set(digest, prefix.length);
  return keccak256(message);
}

async function makeSignedPayload() {
  const canonical = JSON.stringify({
    schema_version: 9,
    timestamp: TIMESTAMP,
    psm_usdc_reserve: PSM_USDC_RESERVE,
    outstanding_kusd: OUTSTANDING_KUSD,
  });
  const attestationHash = `0x${createHash("sha256").update(canonical).digest("hex")}`;
  const signature = await account.sign({ hash: eip191DigestHash(attestationHash) });
  return { canonical, attestationHash, signature };
}

function makeParams() {
  return { signerAddress: SIGNER, psmAddresses: PSMS };
}

function makeCoin(): StablecoinMeta {
  return { id: "kusd-kerne", symbol: "kUSD" } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "kerne-signed-por",
    version: 1,
    semantics: "single-asset",
    inputs: { primary: { kind: "http-json", url: "https://app.kerne.fi/api/por/signed" } },
    params: makeParams(),
  } as unknown as LiveReservesConfig;
}

function toBalanceHex(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

const ONCHAIN_MATCH_RAW = 1_110_888_006n; // 1110.888006 USDC (6 decimals)

beforeEach(() => {
  vi.clearAllMocks();
  signal = new AbortController().signal;
});

describe("adaptKerneSignedPor", () => {
  it("emits the signed PSM USDC slice with verified freshness when the on-chain balance matches", () => {
    const result = adaptKerneSignedPor({
      canonical: { schema_version: 9, timestamp: TIMESTAMP, psm_usdc_reserve: PSM_USDC_RESERVE, outstanding_kusd: OUTSTANDING_KUSD },
      params: makeParams(),
      onchainUsdcRaw: ONCHAIN_MATCH_RAW,
    });

    expect(result.warnings).toBeUndefined();
    expect(result.slices).toEqual([
      expect.objectContaining({
        sourceKey: "kerne-signed-por:psm-usdc",
        name: "USDC held 1:1 in the on-chain Peg Stability Module",
        coinId: "usdc-circle",
        depType: "collateral",
        risk: "low",
      }),
    ]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: TIMESTAMP,
      freshnessMode: "verified",
      totalReserveUsd: PSM_USDC_RESERVE,
      supplyUsd: OUTSTANDING_KUSD,
    });
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(PSM_USDC_RESERVE / OUTSTANDING_KUSD, 9);
    expectValidAdapterOutput("kerne-signed-por", result, { now: TIMESTAMP + 60 });
  });

  it("degrades and keeps the signed value when the on-chain balance diverges", () => {
    const result = adaptKerneSignedPor({
      canonical: { schema_version: 9, timestamp: TIMESTAMP, psm_usdc_reserve: PSM_USDC_RESERVE, outstanding_kusd: OUTSTANDING_KUSD },
      params: makeParams(),
      onchainUsdcRaw: 1_000_000_000n,
    });

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "kerne-onchain-mismatch", effect: "degraded" }),
    ]));
    expect(result.metadata?.totalReserveUsd).toBe(PSM_USDC_RESERVE);
  });

  it("degrades and keeps the signed value when the on-chain read fails", () => {
    const result = adaptKerneSignedPor({
      canonical: { schema_version: 9, timestamp: TIMESTAMP, psm_usdc_reserve: PSM_USDC_RESERVE, outstanding_kusd: OUTSTANDING_KUSD },
      params: makeParams(),
      onchainUsdcRaw: null,
    });

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "kerne-onchain-read-failed", effect: "degraded" }),
    ]));
    expect(result.metadata?.totalReserveUsd).toBe(PSM_USDC_RESERVE);
  });

  it("publishes reserve-undercollateralized when the signed reserve is below outstanding kUSD", () => {
    const result = adaptKerneSignedPor({
      canonical: { schema_version: 9, timestamp: TIMESTAMP, psm_usdc_reserve: 100, outstanding_kusd: 110.5 },
      params: makeParams(),
      onchainUsdcRaw: 100_000_000n,
    });

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }),
    ]));
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(100 / 110.5, 9);
  });

  it("throws when the signed timestamp is missing", () => {
    expect(() => adaptKerneSignedPor({
      canonical: { schema_version: 9, psm_usdc_reserve: PSM_USDC_RESERVE, outstanding_kusd: OUTSTANDING_KUSD },
      params: makeParams(),
      onchainUsdcRaw: ONCHAIN_MATCH_RAW,
    })).toThrow("unreadable timestamp");
  });
});

describe("fetchKerneSignedPorReserves", () => {
  it("verifies the signature, cross-checks the PSM balance, and adapts", async () => {
    const { canonical, attestationHash, signature } = await makeSignedPayload();
    mockedReserveHelper(fetchJsonAdapterInput).mockResolvedValue({
      schema_version: 9,
      signer: SIGNER,
      signature,
      attestation_hash: attestationHash,
      signed_payload_canonical: canonical,
    });
    mockedReserveHelper(fetchOnchainMulticall3).mockResolvedValue([
      { label: "psm-0-balance", success: true, returnData: toBalanceHex(30_000_000n) },
      { label: "psm-1-balance", success: true, returnData: toBalanceHex(995_003_000n) },
      { label: "psm-2-balance", success: true, returnData: toBalanceHex(85_885_006n) },
    ]);

    const result = await fetchKerneSignedPorReserves(makeCoin(), makeConfig(), signal);

    expect(fetchOnchainMulticall3).toHaveBeenCalledWith(expect.objectContaining({
      chain: "base",
      calls: PSMS.map((_address, index) => ({
        label: `psm-${index}-balance`,
        contract: USDC_BASE,
        data: expect.any(String),
        allowFailure: true,
      })),
    }));
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toHaveLength(1);
    expect(result.metadata?.sourceTimestamp).toBe(TIMESTAMP);
  });

  it("fails closed when the signature does not recover the pinned signer", async () => {
    const { canonical, attestationHash } = await makeSignedPayload();
    const stranger = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const signature = await stranger.sign({ hash: eip191DigestHash(attestationHash) });
    mockedReserveHelper(fetchJsonAdapterInput).mockResolvedValue({
      schema_version: 9,
      signer: stranger.address,
      signature,
      attestation_hash: attestationHash,
      signed_payload_canonical: canonical,
    });

    await expect(fetchKerneSignedPorReserves(makeCoin(), makeConfig(), signal)).rejects.toThrow(
      "does not recover the pinned signer",
    );
  });

  it("fails closed when the canonical bytes do not rehash to attestation_hash", async () => {
    const { canonical, signature } = await makeSignedPayload();
    mockedReserveHelper(fetchJsonAdapterInput).mockResolvedValue({
      schema_version: 9,
      signer: SIGNER,
      signature,
      attestation_hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      signed_payload_canonical: canonical,
    });

    await expect(fetchKerneSignedPorReserves(makeCoin(), makeConfig(), signal)).rejects.toThrow(
      "do not rehash to attestation_hash",
    );
  });

  it("propagates an error when the endpoint request fails", async () => {
    mockedReserveHelper(fetchJsonAdapterInput).mockRejectedValue(
      new Error("HTTP 500 for https://app.kerne.fi/api/por/signed"),
    );

    await expect(fetchKerneSignedPorReserves(makeCoin(), makeConfig(), signal)).rejects.toThrow("HTTP 500");
  });
});

describe("registry", () => {
  it("resolves the kerne-signed-por adapter", () => {
    expect(getReserveAdapter("kerne-signed-por")).not.toBeNull();
  });
});
