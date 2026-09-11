import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import { adapterCoins, expectValidAdapterOutput, installAdapterNetwork, runAdapter, type AdapterRpcCall, type AdapterRpcValue, type AdapterRpcWord } from "./reserve-adapter.test-support";

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

const ETHEREUM = "0xa469b7ee9ee773642b3e93e842e5d9b5baa10067";
const BASE = "0x04d5ddf5f3a8939889f11e97f8c4bb48317f1938";
const ARBITRUM = "0x5018609ab477cc502e170a5accf5312b86a4b94f";
const BLAST = "0x52056ed29fe015f4ba2e3b079d10c0b87f46e8c6";
const MANTA = "0x73d23f3778a90be8846e172354a115543df2a7e4";
const SPCT = "0xf30a29f1c540724fd8c5c4be1af604a6c6800d29";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ORACLE = "0x900fff3bbf47ded50fd4940d055e1324f38b0d4f";
const ENDPOINT = "0x1a44076050125825900e736c501f859c50fe728c";
const LAYERZERO_METADATA_URL = "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list?symbols=USDz";
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

const metadataPayload = {
  USDz: [{
    sharedDecimals: 8,
    endpointVersion: "v2",
    deployments: {
      ethereum: { address: ETHEREUM, localDecimals: 18, type: "OFT" },
      base: { address: BASE, localDecimals: 18, type: "OFT" },
    },
  }],
};

function addressArg(selector: string, address: string): string {
  return `${selector}${address.slice(2).padStart(64, "0")}`;
}

interface AnzenNetworkOptions {
  overrides?: Partial<Record<number, `0x${string}`>>;
  codeDrift?: boolean;
  dropSelector?: string;
}

function installAnzenNetwork({
  overrides = {},
  codeDrift = false,
  dropSelector,
}: AnzenNetworkOptions = {}) {
  const chains = ["ethereum", "base", "arbitrum", "blast", "manta"] as const;
  const contracts = [ETHEREUM, BASE, ARBITRUM, BLAST, MANTA];
  const rpc: Record<string, AdapterRpcValue> = {};
  const identitiesByChain = chains.map((chain, chainIndex) => {
    const usdz = contracts[chainIndex]!;
    const identities: Array<[string, string]> = [
      [usdz, "0x18160ddd"],
      [usdz, "0x313ce567"],
      [usdz, "0x95d89b41"],
      [usdz, "0x5e280f11"],
    ];
    if (chain === "ethereum") {
      identities.push(
        [usdz, "0x8abb1eb4"],
        [usdz, "0x090a1cc8"],
        [usdz, "0x3e413bee"],
        [usdz, "0x7dc0d1d0"],
        [usdz, "0x5c975abb"],
        [usdz, "0x58a6be1c"],
        [usdz, "0x295a5212"],
        [usdz, "0x5872e6fa"],
        [usdz, "0xf05a6b6d"],
        [SPCT, addressArg("0x70a08231", usdz)],
        [SPCT, "0x664692f2"],
        [SPCT, "0x5c975abb"],
        [SPCT, "0x5872e6fa"],
        [SPCT, "0xf05a6b6d"],
        [SPCT, addressArg("0xc683630d", usdz)],
        [USDC, addressArg("0x70a08231", SPCT)],
        [USDC, addressArg("0x70a08231", usdz)],
        [ORACLE, "0x98d5fdca"],
      );
    }
    return identities;
  });
  const selectors = new Set(identitiesByChain.flat().map(([, data]) => data.slice(0, 10)));
  const valueForCall = (call: AdapterRpcCall) => {
    const chain = call.chain;
    if (!chain) return null;
    const chainIndex = chains.indexOf(chain as typeof chains[number]);
    const identities = identitiesByChain[chainIndex];
    if (!identities) return null;
    const index = identities.findIndex(([address, data]) =>
      address === call.contract && data === call.data.toLowerCase());
    if (index < 0) return null;
    if (overrides[index] !== undefined) return overrides[index]!;
    if (index === 3 && chainIndex !== 0 && chainIndex !== 1) return null;
    const values: AdapterRpcWord[] = [
      supplies[chainIndex] ?? 0n,
      18n,
      encodeSymbol(),
      chainIndex === 0 || chainIndex === 1 ? ENDPOINT : null,
    ];
    if (chainIndex === 0) {
      values.push(
        pooled,
        SPCT,
        USDC,
        ORACLE,
        false,
        WAD,
        0n,
        0n,
        100_000_000n,
        pooled,
        4_000_000_000n,
        false,
        0n,
        100_000_000n,
        true,
        4_000_000_000n,
        0n,
        WAD,
      );
    }
    return values[index] ?? null;
  };
  for (const selector of selectors) rpc[selector] = valueForCall;
  if (dropSelector) delete rpc[dropSelector];

  const code: Record<string, string> = {};
  for (const [chainIndex, [chain, address]] of chains.map((chain, index) => [chain, contracts[index]!] as const).entries()) {
    code[`${chain}:${address}`] = codeDrift && chain === "blast" ? "0xdead" : `0x600${chainIndex}`;
  }
  code[`ethereum:${SPCT}`] = "0x7000";
  code[`ethereum:${ORACLE}`] = "0x7001";
  code[`ethereum:${USDC}`] = "0x7002";

  return installAdapterNetwork({
    chains: {
      blast: "https://rpc.blast.io",
      manta: "https://pacific-rpc.manta.network/http",
    },
    json: { [LAYERZERO_METADATA_URL]: metadataPayload },
    rpc,
    code,
  });
}

interface AnzenRunOptions extends AnzenNetworkOptions {
  coin?: Partial<StablecoinMeta>;
}

async function runAnzen(options: AnzenRunOptions = {}) {
  const { coin, ...networkOptions } = options;
  const network = installAnzenNetwork(networkOptions);
  const { result } = await runAdapter("anzen-usdz", "usdz-anzen", {
    network,
    ...(coin ? { coin } : {}),
  });
  return { result, network };
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchAnzenUsdzReserves", () => {
  it("uses pooled SPCT, held SPCT, and bridge-adjusted five-chain liabilities", async () => {
    const { result, network } = await runAnzen();

    expect(result.slices).toEqual([{ sourceKey: "anzen-usdz:spct", name: "SPCT (Secured Private Credit Token)", pct: 100, risk: "high", blacklistable: true }]);
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
    expect(network.rpcCalls.some((call) => call.chain === "ethereum" && call.viaMulticall)).toBe(true);
    expect(network.rpcCalls.map((call) => call.chain)).toEqual(
      expect.arrayContaining(["ethereum", "base", "arbitrum", "blast", "manta"]),
    );
    expectValidAdapterOutput("anzen-usdz", result);
  });

  it.each([
    { 4: word(liability - WAD) },
    { 13: word(liability - WAD) },
  ])("publishes pooled or held SPCT shortfalls", async (overrides) => {
    const { result } = await runAnzen({ overrides });
    expect(result.slices[0].pct).toBe(100);
    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }));
    expectValidAdapterOutput("anzen-usdz", result);
  });

  it("values SPCT at its oracle price and publishes an oracle-driven shortfall", async () => {
    const { result } = await runAnzen({ overrides: { 21: word(WAD * 9n / 10n) } });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(Number(pooled) / 1e18 * 0.9, 7);
    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }));
    expect(result.slices[0].blacklistable).toBe(true);
    expectValidAdapterOutput("anzen-usdz", result);
  });

  it("publishes observed surplus above the reviewed tolerance", async () => {
    const { result } = await runAnzen({
      overrides: { 4: word(liability + 1_001n * WAD), 13: word(liability + 1_001n * WAD) },
    });
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
  });

  it("fails closed on reviewed topology, code, and identity drift", async () => {
    const bound = adapterCoins("anzen-usdz")[0];
    if (!bound) throw new Error("missing catalog-bound Anzen coin");
    await expect(runAnzen({
      coin: { contracts: bound.contracts?.filter((entry) => entry.chain !== "blast") },
    })).rejects.toThrow("contract set");

    await expect(runAnzen({ codeDrift: true })).rejects.toThrow("code hash drifted");
    await expect(runAnzen({ overrides: { 5: word("0x1111111111111111111111111111111111111111") } })).rejects.toThrow("spct() identity");
  });

  it("does not call or use global SPCT totalSupply", async () => {
    const { result, network } = await runAnzen();
    const ethereumCalls = network.rpcCalls.filter((call) => call.chain === "ethereum");
    expect(ethereumCalls.map((call) => [call.contract, call.selector])).not.toContainEqual([SPCT, "0x18160ddd"]);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(Number(pooled) / 1e18, 7);
  });

  it("fails closed when the USDz totalSupply field is dropped from the RPC batch", async () => {
    await expect(runAnzen({ dropSelector: "0x18160ddd" })).rejects.toThrow(/total-supply|unanswered/i);
  });

  it("bounds redemption by either reserve USD or combined settlement balances, including zero", async () => {
    for (const [reserve, spct, usdz, expected] of [
      [3_000_000n, 4_000_000n, 2_000_000n, 3],
      [9_000_000n, 4_000_000n, 2_000_000n, 6],
      [9_000_000n, 0n, 0n, 0],
    ] as const) {
      const { result } = await runAnzen({
        overrides: { 14: word(reserve), 19: word(spct), 20: word(usdz) },
      });
      expect(result.metadata?.redemption?.capacityUsd).toBe(expected);
      expect(result.metadata?.details?.redemption).toMatchObject({ routeOpen: expected > 0 });
    }
  });

  it("compounds both fees and rounds at half a basis point", async () => {
    // 1% then 2% retains 97.02%; the small fee cases yield 100.495, 100.5, and 100.594 bps.
    for (const [rate, coefficient, expected] of [[2_000n, 100_000n, 298], [5n, 100_000n, 100], [5n, 99_000n, 101], [6n, 100_000n, 101]] as const) {
      const { result } = await runAnzen({
        overrides: { 11: word(1_000n), 12: word(100_000n), 16: word(rate), 17: word(coefficient) },
      });
      expect(result.metadata?.redemption?.feeBps).toBe(expected);
    }
  });

  it("rejects either invalid fee coefficient or excessive fee rate", async () => {
    for (const overrides of [{ 12: word(0n) }, { 17: word(0n) }, { 11: word(100_000_001n) }, { 16: word(100_000_001n) }]) {
      await expect(runAnzen({ overrides })).rejects.toThrow(/coefficient/);
    }
  });

  it.each([{ 8: word(true) }, { 15: word(true) }, { 18: word(false) }, { 10: word(1n) }, { 21: word(WAD - 1n) }])("publishes blocked redemption routes as paused", async (overrides) => {
    const { result } = await runAnzen({ overrides });
    expect(result.metadata?.redemption?.routeStatus).toBe("paused");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "route-paused", effect: "degraded" }));
  });

  it("rejects malformed pause evidence", async () => {
    await expect(runAnzen({ overrides: { 8: word(2n) } })).rejects.toThrow();
  });
});
