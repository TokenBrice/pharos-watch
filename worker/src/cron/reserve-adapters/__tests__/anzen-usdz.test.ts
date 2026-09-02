import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { mockFetchStrict } from "@shared/test-utils/mock-fetch";

const EXPECTED_HASHES: Record<string, string> = {
  "0x6000": "0x362165471d41a934b39e4b4ae9f54b35faa8835087f182881c2ba79756183ebd",
  "0x6001": "0x313c96fdfbc97ae74b42b004cfb2f42384221747fc9d4e4dc983c75e5797350c",
  "0x6002": "0x6ff74d8b44325ccad039711f6301af381f62a10a113d97fd8ae262dcd197fbeb",
  "0x6003": "0xc873093927468efb942cd20c27b87ffb3df6f5c74e7db1467c3fe18619eb16ab",
  "0x6004": "0x7991d52bae7602ae657da20ec722afa2e060aa0c76486c2e409619d2743e6eab",
  "0x7000": "0xe72ed6f9f3222f61a7901b61e2a44bd7869bf79ac4146c777a97226137baeeaf",
};

vi.mock("viem/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/utils")>();
  return {
    ...actual,
    keccak256: vi.fn((value: `0x${string}`) => EXPECTED_HASHES[value] ?? actual.keccak256(value)),
  };
});

const rpc = vi.hoisted(() => ({
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEvmCodeAtBlock: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/evm-rpc")>();
  return { ...actual, ...rpc };
});

import {
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  MULTICALL3_ADDRESS,
} from "../../../lib/evm-rpc";
import { fetchAnzenUsdzReserves } from "../anzen-usdz";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

const signal = new AbortController().signal;
const ETHEREUM = "0xa469b7ee9ee773642b3e93e842e5d9b5baa10067";
const BASE = "0x04d5ddf5f3a8939889f11e97f8c4bb48317f1938";
const ARBITRUM = "0x5018609ab477cc502e170a5accf5312b86a4b94f";
const BLAST = "0x52056ed29fe015f4ba2e3b079d10c0b87f46e8c6";
const MANTA = "0x73d23f3778a90be8846e172354a115543df2a7e4";
const SPCT = "0xf30a29f1c540724fd8c5c4be1af604a6c6800d29";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ORACLE = "0x900fff3bbf47ded50fd4940d055e1324f38b0d4f";
const ENDPOINT = "0x1a44076050125825900e736c501f859c50fe728c";
const WAD = 10n ** 18n;

function word(value: bigint | boolean | string): `0x${string}` {
  if (typeof value === "string") {
    return `0x${value.replace(/^0x/, "").toLowerCase().padStart(64, "0")}` as `0x${string}`;
  }
  const uint = typeof value === "boolean" ? (value ? 1n : 0n) : value;
  return `0x${uint.toString(16).padStart(64, "0")}` as `0x${string}`;
}

const supplies = [
  806422803388436303620608n,
  6695168794918140000000000n,
  77436723139500000000000n,
  41012515268560000000000n,
  500165777909000000000000n,
] as const;
const liability = supplies.reduce((sum, value) => sum + value, 0n);
const pooled = liability + 86_77219n * 10n ** 13n;

function encodeSymbol(): `0x${string}` {
  return encodeAbiParameters([{ type: "string" }], ["USDz"]);
}

function metadataResponse(): Response {
  return new Response(JSON.stringify({
    USDz: [{
      sharedDecimals: 8,
      endpointVersion: "v2",
      deployments: {
        ethereum: { address: ETHEREUM, localDecimals: 18, type: "OFT" },
        base: { address: BASE, localDecimals: 18, type: "OFT" },
      },
    }],
  }), { headers: { "content-type": "application/json" } });
}

function aggregateFor(chain: string, overrides: Record<number, `0x${string}`> = {}) {
  const chainIndex = ["ethereum", "base", "arbitrum", "blast", "manta"].indexOf(chain);
  const values: `0x${string}`[] = [
    word(supplies[chainIndex] ?? 1n),
    word(18n),
    encodeSymbol(),
    chain === "ethereum" || chain === "base" ? word(ENDPOINT) : word(0n),
  ];
  if (chain === "ethereum") {
    values.push(
      word(overrides[4] ? BigInt(overrides[4]) : pooled),
      word(overrides[5] ?? word(SPCT)),
      word(overrides[6] ?? word(USDC)),
      word(overrides[7] ?? word(ORACLE)),
      overrides[8] ?? word(false),
      overrides[9] ?? word(WAD),
      overrides[10] ?? word(0n),
      overrides[11] ?? word(0n),
      overrides[12] ?? word(100_000_000n),
      overrides[13] ?? word(pooled),
      overrides[14] ?? word(4_000_000_000n),
      overrides[15] ?? word(false),
      overrides[16] ?? word(0n),
      overrides[17] ?? word(100_000_000n),
      overrides[18] ?? word(true),
      overrides[19] ?? word(4_000_000_000n),
      overrides[20] ?? word(0n),
      overrides[21] ?? word(WAD),
    );
  }
  const encoded = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }],
    [[...values.map<[boolean, `0x${string}`]>((returnData, index) => [!(!["ethereum", "base"].includes(chain) && index === 3), returnData])]],
  );
  return encoded;
}

function primeRpcMocks(overrides: Record<number, `0x${string}`> = {}, codeDrift = false): void {
  vi.mocked(fetchEvmCodeAtBlock).mockImplementation(async (chain, address) => {
    if (chain === "ethereum" && address.toLowerCase() === SPCT) return "0x7000";
    if (chain === "ethereum" && address.toLowerCase() === ORACLE) return "0x7001";
    if (chain === "ethereum" && address.toLowerCase() === USDC) return "0x7002";
    const codeIndex = ["ethereum", "base", "arbitrum", "blast", "manta"].indexOf(chain ?? "");
    return codeDrift && chain === "blast" ? "0xdead" : `0x600${codeIndex}` as `0x${string}`;
  });
  vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (chain) => aggregateFor(chain ?? "", overrides));
}

function makeCoin(): StablecoinMeta {
  return {
    id: "usdz-anzen",
    name: "Anzen USDz",
    symbol: "USDz",
    contracts: [
      { chain: "ethereum", address: ETHEREUM, decimals: 18 },
      { chain: "base", address: BASE, decimals: 18 },
      { chain: "arbitrum", address: ARBITRUM, decimals: 18 },
      { chain: "blast", address: BLAST, decimals: 18 },
      { chain: "manta", address: MANTA, decimals: 18 },
    ],
  } as unknown as StablecoinMeta;
}

const config: LiveReservesConfig = {
  adapter: "anzen-usdz",
  version: 2,
  semantics: "single-asset",
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  primeRpcMocks();
  mockFetchStrict([{
    match: "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list?symbols=USDz",
    respond: async () => metadataResponse(),
  }]);
});

afterEach(() => vi.unstubAllGlobals());

describe("fetchAnzenUsdzReserves", () => {
  it("uses pooled SPCT, held SPCT, and bridge-adjusted five-chain liabilities", async () => {
    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.slices).toEqual([{ name: "SPCT (Secured Private Credit Token)", pct: 100, risk: "high" }]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: {
        proofKind: "multichain-usdz-pooled-spct-v2",
        accountedSpctRaw: pooled.toString(),
        heldSpctRaw: pooled.toString(),
        liabilityRaw: liability.toString(),
      },
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(Number(pooled) / 1e18, 7);
    expect(result.metadata?.supplyUsd).toBeCloseTo(Number(liability) / 1e18, 7);
    expect(vi.mocked(fetchEvmCodeAtBlock)).toHaveBeenCalledTimes(8);
    expect(vi.mocked(fetchEvmCallHexAtBlock)).toHaveBeenCalledTimes(5);
    expect(vi.mocked(fetchEvmCallHexAtBlock).mock.calls.map(([chain]) => chain)).toEqual(
      expect.arrayContaining(["ethereum", "base", "arbitrum", "blast", "manta"]),
    );
    for (const [chain, to, _data, block, options] of vi.mocked(fetchEvmCallHexAtBlock).mock.calls) {
      expect(to).toBe(MULTICALL3_ADDRESS);
      expect(block).toBe("latest");
      expect(options).toMatchObject({
        maxRetries: 0,
        timeoutMs: 4_000,
        extraRpcUrls: expect.arrayContaining([expect.stringMatching(/^https:\/\//)]),
      });
      expect(chain).toBeTypeOf("string");
    }
    const ethereumStateRead = vi.mocked(fetchEvmCallHexAtBlock).mock.calls.find(([chain]) => chain === "ethereum");
    expect(ethereumStateRead?.[4]?.extraRpcUrls).toEqual([
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
    ]);
    expectValidAdapterOutput("anzen-usdz", result);
  });

  it("fails closed when pooled SPCT is below liabilities, held SPCT is short, or surplus exceeds tolerance", async () => {
    await expect(fetchAnzenUsdzReserves(makeCoin(), config, signal)).resolves.toBeTruthy();

    primeRpcMocks({ 4: word(liability - 1n) });
    await expect(fetchAnzenUsdzReserves(makeCoin(), config, signal)).rejects.toThrow("below USDz liabilities");

    primeRpcMocks({ 4: word(pooled), 13: word(pooled - 1n) });
    await expect(fetchAnzenUsdzReserves(makeCoin(), config, signal)).rejects.toThrow("held SPCT");

    primeRpcMocks({ 4: word(liability + 1_001n * WAD), 13: word(liability + 1_001n * WAD) });
    await expect(fetchAnzenUsdzReserves(makeCoin(), config, signal)).rejects.toThrow("surplus");
  });

  it("fails closed on reviewed topology, code, identity, pause, and redemption drift", async () => {
    const coin = makeCoin();
    coin.contracts = coin.contracts?.filter((entry) => entry.chain !== "blast");
    await expect(fetchAnzenUsdzReserves(coin, config, signal)).rejects.toThrow("contract set");

    primeRpcMocks({}, true);
    await expect(fetchAnzenUsdzReserves(makeCoin(), config, signal)).rejects.toThrow("code hash drifted");

    primeRpcMocks({ 5: word("0x1111111111111111111111111111111111111111") });
    await expect(fetchAnzenUsdzReserves(makeCoin(), config, signal)).rejects.toThrow("spct() identity");

    primeRpcMocks({ 8: word(true) });
    await expect(fetchAnzenUsdzReserves(makeCoin(), config, signal)).rejects.toThrow("paused");
  });

  it("does not call or use global SPCT totalSupply", async () => {
    await fetchAnzenUsdzReserves(makeCoin(), config, signal);
    for (const [chain, to, data] of vi.mocked(fetchEvmCallHexAtBlock).mock.calls) {
      if (chain === "ethereum") {
        expect(to).toBe(MULTICALL3_ADDRESS);
        expect(data.toLowerCase()).toContain(SPCT.slice(2));
      }
    }
  });
});
