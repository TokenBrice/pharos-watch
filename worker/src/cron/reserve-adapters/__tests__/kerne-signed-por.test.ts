import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { hexToBytes, keccak256 } from "viem/utils";
import { privateKeyToAccount } from "viem/accounts";
import { adaptKerneSignedPor } from "../kerne-signed-por";
import { getReserveAdapter } from "../index";
import { expectValidAdapterOutput, runAdapter } from "./reserve-adapter.test-support";

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const SIGNER = account.address;

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const KERNE_URL = "https://app.kerne.fi/api/por/signed";
const PSMS = [
  "0xaBDE1138aa1Ce88d1dF06422C0c3b05D70569803",
  "0x07eBb486e11BD217e6085eb5ab663e4517595993",
  "0xFf3025ec18e301855aB0f36Ec6ECa115a29A5Fbc",
];

const TIMESTAMP = 1_788_977_221;
const PSM_USDC_RESERVE = 1110.888006;
const OUTSTANDING_KUSD = 1109.707154;
const ONCHAIN_MATCH_RAW = 1_110_888_006n;

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
  return { id: "kusd-kerne", symbol: "kUSD", liveReservesConfig: makeConfig() } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "kerne-signed-por",
    version: 1,
    semantics: "single-asset",
    inputs: { primary: { kind: "http-json", url: KERNE_URL } },
    params: makeParams(),
  } as unknown as LiveReservesConfig;
}


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
  async function kerneNetwork(payloadOverrides: Record<string, unknown> = {}) {
    const { canonical, attestationHash, signature } = await makeSignedPayload();
    const balances = [30_000_000n, 995_003_000n, 85_885_006n];
    return {
      json: {
        [KERNE_URL]: {
          schema_version: 9,
          signer: SIGNER,
          signature,
          attestation_hash: attestationHash,
          signed_payload_canonical: canonical,
          ...payloadOverrides,
        },
      },
      rpc: {
        [`base:${USDC_BASE}:balanceOf(address)`]: ({ data }: { data: string }) => {
          const address = data.slice(-40);
          const index = PSMS.findIndex((psm) => psm.slice(2).toLowerCase() === address);
          return balances[index] ?? null;
        },
      },
    };
  }

  it("verifies the signature, cross-checks the PSM balance, and adapts through the shared network harness", async () => {
    const network = await kerneNetwork();
    const { result, network: installed } = await runAdapter("kerne-signed-por", makeCoin(), {
      network,
      nowSec: TIMESTAMP + 60,
    });

    expect(installed.requests.map((request) => request.url)).toContain(KERNE_URL);
    expect(installed.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ chain: "base", contract: USDC_BASE, viaMulticall: true }),
    ]));
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toHaveLength(1);
    expect(result.metadata?.sourceTimestamp).toBe(TIMESTAMP);
  });

  it("fails closed when the signature does not recover the pinned signer", async () => {
    const { canonical, attestationHash } = await makeSignedPayload();
    const stranger = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const signature = await stranger.sign({ hash: eip191DigestHash(attestationHash) });

    await expect(runAdapter("kerne-signed-por", makeCoin(), {
      network: await kerneNetwork({
        signer: stranger.address,
        signature,
        attestation_hash: attestationHash,
        signed_payload_canonical: canonical,
      }),
      nowSec: TIMESTAMP + 60,
      validate: false,
    })).rejects.toThrow("does not recover the pinned signer");
  });

  it("fails closed when the canonical bytes do not rehash to attestation_hash", async () => {
    const { canonical, signature } = await makeSignedPayload();

    await expect(runAdapter("kerne-signed-por", makeCoin(), {
      network: await kerneNetwork({
        signature,
        attestation_hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        signed_payload_canonical: canonical,
      }),
      nowSec: TIMESTAMP + 60,
      validate: false,
    })).rejects.toThrow("do not rehash to attestation_hash");
  });

  it("propagates an endpoint failure", async () => {
    await expect(runAdapter("kerne-signed-por", makeCoin(), {
      network: {
        json: { [KERNE_URL]: { status: 500, body: "upstream unavailable" } },
        rpc: { [`base:${USDC_BASE}:balanceOf(address)`]: 0n },
      },
      nowSec: TIMESTAMP + 60,
      validate: false,
    })).rejects.toThrow(/500/);
  });
});

describe("registry", () => {
  it("resolves the kerne-signed-por adapter", () => {
    expect(getReserveAdapter("kerne-signed-por")).not.toBeNull();
  });
});
