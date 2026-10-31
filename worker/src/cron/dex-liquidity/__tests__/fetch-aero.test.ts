import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import type { EvmRpcOptions } from "../../../lib/evm-rpc";

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockHeader: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));

import { fetchEvmBlockHeader, fetchEvmBlockNumber, fetchEvmMulticall3Aggregate3AtBlock } from "../../../lib/evm-rpc";
import { AERO_CHAINS, aeroBaseFeeBps, fetchAeroBasicPools, fetchAeroSlipstreamPools } from "../fetch-aero";
import { buildChainAddressKey } from "../token-resolution";

const CL_FACTORY = "0x9cb220581b91b0c83223012fe69688b92ad07a76";
const STABLE_FACTORY = "0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d";
const VOLATILE_FACTORY = "0x8e6a9fcd1d638cc760ffba397605fe3355de76d2";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
const WETH = "0x4200000000000000000000000000000000000006";
const OTHER = "0x00000000000000000000000000000000000000aa";
const CL_POOL = "0xd448990883e3bf9cdd8ebca368a3ecf9d629aaf7";
const CL_UNTRACKED = "0x00000000000000000000000000000000000000c1";
const STABLE_POOL = "0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f";
const VOLATILE_POOL = "0x00000000000000000000000000000000000000b2";

const encode = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values);
const uint = (value: bigint | number) => encode("uint256", [BigInt(value)]);
const address = (value: string) => encode("address", [value]);
const string = (value: string) => encode("string", [value]);

const chainAddressToId = new Map([
  [buildChainAddressKey("base", USDC), "usdc-circle"],
  [buildChainAddressKey("base", USDT), "usdt-tether"],
]);
const trackedStablecoinPrices = new Map([["usdc-circle", 1], ["usdt-tether", 0.999]]);
const SYMBOLS: Record<string, string> = { [USDC]: "USDC", [USDT]: "USDT", [WETH]: "WETH", [OTHER]: "OTHER" };

type Responder = (label: string, target: string, options?: EvmRpcOptions) => `0x${string}` | null;

function mockBase(respond: Responder) {
  vi.mocked(fetchEvmBlockNumber).mockImplementation(async (chain) => (chain === "base" ? 100 : null));
  vi.mocked(fetchEvmBlockHeader).mockResolvedValue({ number: 100, hash: "0xabc", timestamp: 1 } as never);
  vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls, _block, options) => calls.map((call) => {
    const returnData = call.label.endsWith("-symbol")
      ? string(SYMBOLS[call.target] ?? "")
      : respond(call.label, call.target, options);
    return { label: call.label, success: returnData != null, returnData: returnData ?? "0x" };
  }));
}

afterEach(() => vi.resetAllMocks());

describe("aeroBaseFeeBps", () => {
  it("converts tick-spacing base fees from pips and rejects malformed values", () => {
    expect(aeroBaseFeeBps(100)).toBe(1);
    expect(aeroBaseFeeBps(500)).toBe(5);
    expect(aeroBaseFeeBps(20_000)).toBe(200);
    expect(aeroBaseFeeBps(0)).toBeNull();
    expect(aeroBaseFeeBps(null)).toBeNull();
    expect(aeroBaseFeeBps(1_000_001)).toBeNull();
  });
});

describe("fetchAeroSlipstreamPools", () => {
  it("enumerates the CL factory, keeps tracked pools and buckets by the tick-spacing base fee", async () => {
    const pools = [CL_POOL, CL_UNTRACKED];
    mockBase((label, target, options) => {
      if (label.startsWith("count-")) return uint(target === CL_FACTORY ? 2 : 0);
      if (target === CL_FACTORY && label.startsWith(`${CL_FACTORY}-`)) return address(pools[Number(label.split("-").pop())]!);
      if (label === `${CL_POOL}-token0`) return address(USDC);
      if (label === `${CL_POOL}-token1`) return address(USDT);
      if (label === `${CL_UNTRACKED}-token0`) return address(WETH);
      if (label === `${CL_UNTRACKED}-token1`) return address(OTHER);
      if (label === "cl-0-factory") return address(CL_FACTORY);
      if (label === "cl-0-token0") return address(USDC);
      if (label === "cl-0-token1") return address(USDT);
      if (label === "cl-0-tickSpacing") return encode("int24", [1]);
      if (label === "cl-0-slot0") return encode("uint160,int24", [1n << 96n, 0]);
      if (label === "cl-0-membership") return address(CL_POOL);
      if (label.endsWith("-decimals")) return uint(6);
      if (label === "cl-0-token-0-balance") return uint(2_000_000n * 10n ** 6n);
      if (label === "cl-0-token-1-balance") return uint(1_000_000n * 10n ** 6n);
      // The confirmed capture serves 1bp; a numeric-tag read resolves a
      // different (300bp) tier from the lagging backend.
      if (label === "fee-1") return encode("uint24", [options?.stateBlockHash === "0xabc" ? 100 : 30_000]);
      return null;
    });

    const result = await fetchAeroSlipstreamPools({ chainAddressToId, trackedStablecoinPrices });

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      source: "aero-slipstream",
      chain: "base",
      poolAddress: CL_POOL,
      poolType: "aero-slipstream-1bp",
      feeRate: 0.0001,
      tickSpacing: 1,
      volume24hUsd: null,
      balances: [2_000_000, 1_000_000],
    });
    expect(result.pools[0]!.tokens.map((token) => token.symbol)).toEqual(["USDC", "USDT"]);
    expect(result.pools[0]!.tokens.map((token) => token.priceUsd)).toEqual([undefined, undefined]);
    expect(result.pools[0]!.tvlUsd).toBeCloseTo(2_999_000, 0);
    // The tier and symbol reads stay inside the capture's proven block view.
    const pinnedReads = vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mock.calls.filter(([, calls]) =>
      calls.some((call) => call.label === "fee-1" || call.label.endsWith("-symbol")));
    expect(pinnedReads.length).toBeGreaterThan(0);
    expect(pinnedReads.every(([, , , options]) => options?.stateBlockHash === "0xabc")).toBe(true);
    // Chains without a block are reported per chain, not hidden behind ok.
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.errors).toEqual(AERO_CHAINS.filter((chain) => chain !== "base").map((chain) => `${chain}:block-unavailable`));
  });

  it("reads only the oldest bounded pools of an oversized factory and names the degradation", async () => {
    mockBase((label, target) => (label.startsWith("count-") ? uint(target === CL_FACTORY ? 5_001 : 0) : null));
    const result = await fetchAeroSlipstreamPools({ chainAddressToId, trackedStablecoinPrices });
    const listCalls = vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mock.calls
      .flatMap(([, calls]) => calls).filter((call) => call.label.startsWith(`${CL_FACTORY}-`));
    expect(listCalls).toHaveLength(5_000);
    expect(listCalls[listCalls.length - 1]!.label).toBe(`${CL_FACTORY}-4999`);
    expect(result.degraded).toBe(true);
    expect(result.errors[0]).toBe(`base:pool-count-cap:${CL_FACTORY}:5001`);
  });
});

describe("fetchAeroBasicPools", () => {
  function mockBasic(overrides: Record<string, `0x${string}` | null> = {}) {
    mockBase((label, target) => {
      if (label in overrides) return overrides[label]!;
      if (label.startsWith("count-")) return uint(target === STABLE_FACTORY || target === VOLATILE_FACTORY ? 1 : 0);
      if (label === `${STABLE_FACTORY}-0`) return address(STABLE_POOL);
      if (label === `${VOLATILE_FACTORY}-0`) return address(VOLATILE_POOL);
      if (label === `${STABLE_POOL}-factory`) return address(STABLE_FACTORY);
      if (label === `${VOLATILE_POOL}-factory`) return address(VOLATILE_FACTORY);
      if (label === `${STABLE_POOL}-metadata`) {
        return encode("uint256,uint256,uint256,uint256,address,address", [10n ** 6n, 10n ** 6n, 500_000n * 10n ** 6n, 400_000n * 10n ** 6n, USDC, USDT]);
      }
      if (label === `${VOLATILE_POOL}-metadata`) {
        return encode("uint256,uint256,uint256,uint256,address,address", [10n ** 18n, 10n ** 6n, 100n * 10n ** 18n, 240_000n * 10n ** 6n, WETH, USDC]);
      }
      if (label === STABLE_POOL || label === VOLATILE_POOL) return address(label);
      return null;
    });
  }

  it("prices volatile pools from the x*y=k reserve ratio and stable pools only from tracked sides", async () => {
    mockBasic();
    const result = await fetchAeroBasicPools({ chainAddressToId, trackedStablecoinPrices });
    const byAddress = new Map(result.pools.map((pool) => [pool.poolAddress, pool]));
    expect(byAddress.get(STABLE_POOL)).toMatchObject({
      source: "aero-basic", poolType: "aero-stable", price: null, feeRate: null, balances: [500_000, 400_000],
    });
    expect(byAddress.get(STABLE_POOL)!.tvlUsd).toBeCloseTo(899_600, 0);
    expect(byAddress.get(VOLATILE_POOL)).toMatchObject({ poolType: "aero-volatile", price: 2_400 });
    expect(byAddress.get(VOLATILE_POOL)!.tokens.map((token) => [token.symbol, token.priceUsd])).toEqual([["WETH", 2_400], ["USDC", undefined]]);
  });

  it("drops pools whose factory membership or metadata decimals do not prove identity", async () => {
    mockBasic({
      [STABLE_POOL]: address(OTHER),
      [`${VOLATILE_POOL}-metadata`]: encode("uint256,uint256,uint256,uint256,address,address", [18n, 10n ** 6n, 1n, 1n, WETH, USDC]),
    });
    const result = await fetchAeroBasicPools({ chainAddressToId, trackedStablecoinPrices });
    expect(result.pools).toEqual([]);
  });

  it("does not price a stable pool with an untracked side", async () => {
    mockBasic({
      [`${STABLE_POOL}-metadata`]: encode("uint256,uint256,uint256,uint256,address,address", [10n ** 6n, 10n ** 18n, 1n, 1n, USDC, OTHER]),
    });
    const result = await fetchAeroBasicPools({ chainAddressToId, trackedStablecoinPrices });
    expect(result.pools.map((pool) => pool.poolAddress)).toEqual([VOLATILE_POOL]);
  });

  it("keeps an explicit zero-sided stable pool when both sides are independently priced", async () => {
    mockBasic({
      [`${STABLE_POOL}-metadata`]: encode("uint256,uint256,uint256,uint256,address,address", [10n ** 6n, 10n ** 6n, 500_000n * 10n ** 6n, 0n, USDC, USDT]),
    });
    const result = await fetchAeroBasicPools({ chainAddressToId, trackedStablecoinPrices });
    expect(result.pools.find((pool) => pool.poolAddress === STABLE_POOL)).toMatchObject({ balances: [500_000, 0], tvlUsd: 500_000 });
  });

  it("reports unreadable pool state as named degradation instead of clean absence", async () => {
    mockBasic({ [`${VOLATILE_POOL}-metadata`]: null });
    const result = await fetchAeroBasicPools({ chainAddressToId, trackedStablecoinPrices });
    expect(result.pools.map((pool) => pool.poolAddress)).toEqual([STABLE_POOL]);
    expect(result.errors).toContain("base:pool-state-unreadable:1");
    expect(result.degraded).toBe(true);
  });
});

describe("Aero run budget", () => {
  it("stops before the provider timeout and names each skipped chain", async () => {
    mockBase((label) => (label.startsWith("count-") ? uint(0) : null));
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValue(10 * 60_000);
    const result = await fetchAeroSlipstreamPools({ chainAddressToId, trackedStablecoinPrices });
    now.mockRestore();
    expect(result.errors).toEqual(AERO_CHAINS.map((chain) => `${chain}:run-budget-exhausted`));
    expect(vi.mocked(fetchEvmBlockNumber)).not.toHaveBeenCalled();
  });
});

describe("Aero price evidence", () => {
  it("emits no direct price observation from tracked references alone", async () => {
    const { extractPriceObservations } = await import("../../../lib/dex-api-pool-shaping");
    const pool = {
      source: "aero-basic" as const, chain: "base", poolAddress: STABLE_POOL, poolType: "aero-stable",
      tokens: [{ address: USDC, symbol: "USDC", decimals: 6 }, { address: USDT, symbol: "USDT", decimals: 6 }],
      price: null, tvlUsd: 900_000, volume24hUsd: null, feeRate: null, balances: [500_000, 400_000],
    };
    const observations = extractPriceObservations([pool], chainAddressToId, new Map(), undefined, trackedStablecoinPrices);
    expect(observations.size).toBe(0);
  });
});
