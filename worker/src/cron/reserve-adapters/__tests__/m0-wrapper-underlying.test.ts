import { beforeEach, describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import { fetchWithRetryMock, resetRpcMocks, testChainRpcs } from "./helpers/rpc-mock";

const WRAPPER = "0x437cc33344a0b27a429f795ff6b469c72698b291";
const M_TOKEN = "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b";
const SWAP_FACILITY = "0xb6807116b3b1b321a390594e31ecd6e0076f6278";
const SWAPPER = "0xd925c84b55e4e44a53749ff5f2a5a13f63d128fd";

function uint256Result(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function addressResult(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

function baseConfig(overrides: Partial<LiveReservesConfig["params"]> = {}): LiveReservesConfig {
  return {
    adapter: "m0-wrapper-underlying",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
    },
    params: {
      mode: "wrapped-m-token",
      wrapperAddress: WRAPPER,
      expectedMTokenAddress: M_TOKEN,
      slice: {
        name: "M token held by wrapper",
        risk: "very-low",
        coinId: "m-m0",
        depType: "wrapper",
      },
      ...overrides,
    },
  };
}

describe("fetchM0WrapperUnderlyingReserves", () => {
  beforeEach(() => {
    resetRpcMocks();
  });

  it("reads direct WrappedMToken M balance as live redemption capacity", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
      const call = body.params[0];
      const to = call.to?.toLowerCase();
      if (call.data === "0xc3b6f939") return jsonResponse({ result: addressResult(M_TOKEN) });
      if (call.data === "0x18160ddd") return jsonResponse({ result: uint256Result(80_000_000_000000n) });
      if (call.data === "0x313ce567") return jsonResponse({ result: uint256Result(6) });
      if (to === M_TOKEN && call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(81_000_000_000000n) });
      }
      return null;
    });

    const { fetchM0WrapperUnderlyingReserves } = await import("../m0-wrapper-underlying");
    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "wm-m0", contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }] } as StablecoinMeta,
      baseConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.slices).toEqual([
      { name: "M token held by wrapper", pct: 100, risk: "very-low", coinId: "m-m0", depType: "wrapper" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      wrapperAddress: WRAPPER,
      mTokenAddress: M_TOKEN,
      totalSupplyRaw: "80000000000000",
      underlyingBalanceRaw: "81000000000000",
      collateralizationRatio: 1.0125,
      redemption: {
        capacityUsd: 81_000_000,
        capacityRatioOfSupply: 1,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
      },
    });
  }, 15_000);

  it("verifies an M extension route through SwapFacility", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
      const call = body.params[0];
      const to = call.to?.toLowerCase();
      if (call.data === "0xc3b6f939") return jsonResponse({ result: addressResult(M_TOKEN) });
      if (call.data === "0xae06b7e4") return jsonResponse({ result: addressResult(SWAP_FACILITY) });
      if (call.data === "0x18160ddd") return jsonResponse({ result: uint256Result(4_000_000_000000n) });
      if (call.data === "0x313ce567") return jsonResponse({ result: uint256Result(6) });
      if (to === M_TOKEN && call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(4_000_000_000000n) });
      }
      if (to === SWAP_FACILITY && call.data === "0x5c975abb") return jsonResponse({ result: uint256Result(0) });
      if (to === SWAP_FACILITY && call.data.startsWith("0xd8e21132")) {
        expect(call.data.toLowerCase()).toContain(SWAPPER.slice(2));
        expect(call.data.toLowerCase()).toContain(WRAPPER.slice(2));
        expect(call.data.toLowerCase()).toContain(M_TOKEN.slice(2));
        return jsonResponse({ result: uint256Result(1) });
      }
      return null;
    });

    const { fetchM0WrapperUnderlyingReserves } = await import("../m0-wrapper-underlying");
    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "usdsc-startale" } as StablecoinMeta,
      baseConfig({
        mode: "m-extension",
        expectedSwapFacilityAddress: SWAP_FACILITY,
        swapperAddress: SWAPPER,
      }),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.metadata).toMatchObject({
      swapFacilityAddress: SWAP_FACILITY,
      swapFacilityPaused: false,
      swapperCanRedeem: true,
      redemption: {
        capacityUsd: 4_000_000,
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "whitelisted-primary",
      },
    });
  });

  it("degrades M extension capacity when route probes cannot be verified", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
      const call = body.params[0];
      const to = call.to?.toLowerCase();
      if (call.data === "0xc3b6f939") return jsonResponse({ result: addressResult(M_TOKEN) });
      if (call.data === "0xae06b7e4") return jsonResponse({ result: addressResult(SWAP_FACILITY) });
      if (call.data === "0x18160ddd") return jsonResponse({ result: uint256Result(4_000_000_000000n) });
      if (call.data === "0x313ce567") return jsonResponse({ result: uint256Result(6) });
      if (to === M_TOKEN && call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(4_000_000_000000n) });
      }
      if (to === SWAP_FACILITY && (call.data === "0x5c975abb" || call.data.startsWith("0xd8e21132"))) {
        return jsonResponse({ error: { code: -32000, message: "route probe unavailable" } });
      }
      return null;
    });

    const { fetchM0WrapperUnderlyingReserves } = await import("../m0-wrapper-underlying");
    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "usdsc-startale" } as StablecoinMeta,
      baseConfig({
        mode: "m-extension",
        expectedSwapFacilityAddress: SWAP_FACILITY,
        swapperAddress: SWAPPER,
      }),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.metadata).toMatchObject({
      redemption: {
        capacityUsd: 4_000_000,
        routeStatus: "unknown",
        routeStatusSource: "onchain",
        routeStatusReason: "Could not verify M0 SwapFacility redemption path status",
      },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "m0-extension-route-unverified",
        effect: "degraded",
        severity: "warning",
      }),
    ]);
  });

  it("degrades under-backed wrappers instead of publishing score-grade coverage", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
      const call = body.params[0];
      const to = call.to?.toLowerCase();
      if (call.data === "0xc3b6f939") return jsonResponse({ result: addressResult(M_TOKEN) });
      if (call.data === "0x18160ddd") return jsonResponse({ result: uint256Result(100_000_000_000000n) });
      if (call.data === "0x313ce567") return jsonResponse({ result: uint256Result(6) });
      if (to === M_TOKEN && call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(92_000_000_000000n) });
      }
      return null;
    });

    const { fetchM0WrapperUnderlyingReserves } = await import("../m0-wrapper-underlying");
    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "wm-m0", contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }] } as StablecoinMeta,
      baseConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.metadata).toMatchObject({
      totalSupplyRaw: "100000000000000",
      underlyingBalanceRaw: "92000000000000",
      collateralizationRatio: 0.92,
      redemption: {
        capacityUsd: 92_000_000,
        capacityRatioOfSupply: 0.92,
      },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
        severity: "warning",
      }),
    ]);
  });

  it("does not report a deployment breakdown when no additionalDeployments are configured", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
      const call = body.params[0];
      const to = call.to?.toLowerCase();
      if (call.data === "0xc3b6f939") return jsonResponse({ result: addressResult(M_TOKEN) });
      if (call.data === "0x18160ddd") return jsonResponse({ result: uint256Result(80_000_000_000000n) });
      if (call.data === "0x313ce567") return jsonResponse({ result: uint256Result(6) });
      if (to === M_TOKEN && call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(81_000_000_000000n) });
      }
      return null;
    });

    const { fetchM0WrapperUnderlyingReserves } = await import("../m0-wrapper-underlying");
    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "wm-m0", contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }] } as StablecoinMeta,
      baseConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.metadata?.deployments).toBeUndefined();
  });

  it("aggregates supply and underlying balance across the primary chain and additionalDeployments", async () => {
    const ETHEREUM_TOTAL_SUPPLY = 130_407_000000n;
    const ETHEREUM_M_BALANCE = 130_470_000000n;
    const FLUENT_TOTAL_SUPPLY = 2_925_967_000000n;
    const FLUENT_M_BALANCE = 2_929_656_000000n;

    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
      const call = body.params[0];
      const to = call.to?.toLowerCase();
      const isFluent = url === "https://rpc.fluent.xyz";
      if (call.data === "0xc3b6f939") return jsonResponse({ result: addressResult(M_TOKEN) });
      if (call.data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(isFluent ? FLUENT_TOTAL_SUPPLY : ETHEREUM_TOTAL_SUPPLY) });
      }
      if (call.data === "0x313ce567") return jsonResponse({ result: uint256Result(6) });
      if (to === M_TOKEN && call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(isFluent ? FLUENT_M_BALANCE : ETHEREUM_M_BALANCE) });
      }
      return null;
    });

    const { fetchM0WrapperUnderlyingReserves } = await import("../m0-wrapper-underlying");
    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "usdnr-nerona", contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }] } as StablecoinMeta,
      baseConfig({ additionalDeployments: [{ chain: "fluent" }] }),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    const totalSupplyRaw = ETHEREUM_TOTAL_SUPPLY + FLUENT_TOTAL_SUPPLY;
    const underlyingBalanceRaw = ETHEREUM_M_BALANCE + FLUENT_M_BALANCE;
    expect(result.metadata).toMatchObject({
      totalSupplyRaw: totalSupplyRaw.toString(),
      underlyingBalanceRaw: underlyingBalanceRaw.toString(),
      deployments: [
        {
          chain: "ethereum",
          totalSupplyRaw: ETHEREUM_TOTAL_SUPPLY.toString(),
          underlyingBalanceRaw: ETHEREUM_M_BALANCE.toString(),
        },
        {
          chain: "fluent",
          totalSupplyRaw: FLUENT_TOTAL_SUPPLY.toString(),
          underlyingBalanceRaw: FLUENT_M_BALANCE.toString(),
        },
      ],
    });
    const collateralizationRatio = result.metadata?.collateralizationRatio as number;
    expect(collateralizationRatio).toBeCloseTo(Number(underlyingBalanceRaw) / Number(totalSupplyRaw), 6);
    expect(collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings ?? []).toEqual([]);
  }, 15_000);

  it("fails closed when an additional deployment's reads fail, refusing to aggregate fewer chains", async () => {
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "https://rpc.fluent.xyz") {
        return jsonResponse({ error: { code: -32000, message: "eth_call unavailable" } });
      }
      const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
      const call = body.params[0];
      const to = call.to?.toLowerCase();
      if (call.data === "0xc3b6f939") return jsonResponse({ result: addressResult(M_TOKEN) });
      if (call.data === "0x18160ddd") return jsonResponse({ result: uint256Result(130_407_000000n) });
      if (call.data === "0x313ce567") return jsonResponse({ result: uint256Result(6) });
      if (to === M_TOKEN && call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(130_470_000000n) });
      }
      return null;
    });

    const { fetchM0WrapperUnderlyingReserves } = await import("../m0-wrapper-underlying");
    await expect(
      fetchM0WrapperUnderlyingReserves(
        { id: "usdnr-nerona", contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }] } as StablecoinMeta,
        baseConfig({ additionalDeployments: [{ chain: "fluent" }] }),
        new AbortController().signal,
        { chainRpcs: testChainRpcs },
      ),
    ).rejects.toThrow(/additional deployment fluent .*refusing partial aggregate/);
  });
});
