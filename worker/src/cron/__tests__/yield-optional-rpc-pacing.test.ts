/**
 * B-lane pacing regression coverage: a hot or stalled endpoint must fail over to
 * the alternate URL before any endpoint is retried, and a stalled target may
 * only spend its fair share of the family budget so the remaining inventory is
 * still probed (2026-09-23 incident: Compound's first target consumed the whole
 * 30s family budget on the stalled ethereum endpoint and its keyed alternate was
 * never reached).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChainRpcConfig } from "../../lib/chain-registry";
import { makeChainRpcConfig } from "../../test-helpers/chain-rpc-fixtures.test-support";
import { COMPOUND_V3_COMETS } from "../yield-sync/sources-optional-protocols-constants";
import {
  fetchAaveV3SupplyRates,
  fetchCompoundV3SupplyRates,
  type AaveV3RateTarget,
} from "../yield-sync/sources-rpc";

const COMPOUND_GET_UTILIZATION = "0x7eb71131";
const COMPOUND_GET_SUPPLY_RATE = "0xd955759d";
const ERC20_TOTAL_SUPPLY = "0x18160ddd";
const AAVE_GET_RESERVE_DATA = "0x35ea6a75";
const SECONDS_PER_YEAR = 31_536_000;
const FAMILY_BUDGET_MS = 30_000;

const ATOKEN_ADDRESS = "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c";
const RAY_FIVE_PERCENT = 50_000_000_000_000_000_000_000_000n;

function uint256Word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function rpcResultHex(value: bigint): string {
  return `0x${uint256Word(value)}`;
}

function buildAaveReserveDataHex(): string {
  const words = Array.from({ length: 9 }, () => "0".repeat(64));
  words[2] = uint256Word(RAY_FIVE_PERCENT);
  words[8] = ATOKEN_ADDRESS.slice(2).padStart(64, "0");
  return `0x${words.join("")}`;
}

function installRpcFetchStub(params: {
  hangUrls: readonly string[];
  resolveResult: (callData: string) => string;
}): { calls: string[]; callsByUrl: Map<string, number> } {
  const calls: string[] = [];
  const callsByUrl = new Map<string, number>();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    callsByUrl.set(url, (callsByUrl.get(url) ?? 0) + 1);
    if (params.hangUrls.includes(url)) {
      // A hot endpoint that never answers: only the attempt timeout ends it.
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { params?: Array<{ data?: string }> };
    const callData = body.params?.[0]?.data ?? "";
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: params.resolveResult(callData) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { calls, callsByUrl };
}

function makeChainRpcs(chains: readonly string[]): Map<string, ChainRpcConfig> {
  return new Map(chains.map((chain): [string, ChainRpcConfig] => [
    chain,
    makeChainRpcConfig({
      chainId: chain,
      rpcUrls: [`https://rpc.${chain}.example.com`, `https://fallback.${chain}.example.com`],
      explorerUrl: `https://explorer.${chain}.example.com`,
    }),
  ]));
}

/**
 * Drives fake timers until the operation settles, so a test can assert how much
 * of the family budget the family actually spent.
 */
async function settleWithinBudget<T>(
  operation: Promise<T>,
  capMs: number,
): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = Date.now();
  let settled = false;
  const tracked = operation.finally(() => {
    settled = true;
  });
  while (!settled && Date.now() - startedAt < capMs) {
    await vi.advanceTimersByTimeAsync(250);
  }
  return { value: await tracked, elapsedMs: Date.now() - startedAt };
}

function resolveCompoundResult(callData: string): string {
  if (callData.startsWith(COMPOUND_GET_UTILIZATION)) return rpcResultHex(100_000_000_000_000_000n);
  if (callData.startsWith(COMPOUND_GET_SUPPLY_RATE)) return rpcResultHex(10_000_000_000n);
  return rpcResultHex(1_000_000_000_000n);
}

function resolveAaveResult(callData: string): string {
  if (callData.startsWith(AAVE_GET_RESERVE_DATA)) return buildAaveReserveDataHex();
  if (callData.startsWith(ERC20_TOTAL_SUPPLY)) return rpcResultHex(1_000_000_000_000n);
  return rpcResultHex(0n);
}

const AAVE_TARGETS: AaveV3RateTarget[] = [
  { stablecoinId: "usdc-circle", symbol: "USDC", chain: "ethereum", assetAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", assetDecimals: 6 },
  { stablecoinId: "usdc-circle", symbol: "USDC", chain: "base", assetAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", assetDecimals: 6 },
  { stablecoinId: "usdt-tether", symbol: "USDT", chain: "ethereum", assetAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", assetDecimals: 6 },
  { stablecoinId: "usdt-tether", symbol: "USDT", chain: "arbitrum", assetAddress: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", assetDecimals: 6 },
  { stablecoinId: "dai-makerdao", symbol: "DAI", chain: "ethereum", assetAddress: "0x6b175474e89094c44da98b954eedeac495271d0f", assetDecimals: 18 },
  { stablecoinId: "pyusd-paypal", symbol: "PYUSD", chain: "ethereum", assetAddress: "0x6c3ea9036406852006290770bedfcaba0e23a0e8", assetDecimals: 6 },
];

describe("optional RPC family endpoint pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fails over to the alternate endpoint when the first endpoint stalls, and still probes every other target", async () => {
    const { calls, callsByUrl } = installRpcFetchStub({
      // Target 0 (ethereum:USDC, even rotation seed) tries the fallback URL first.
      hangUrls: ["https://fallback.ethereum.example.com"],
      resolveResult: resolveCompoundResult,
    });
    const { value: { results, telemetry }, elapsedMs } = await settleWithinBudget(
      fetchCompoundV3SupplyRates([...COMPOUND_V3_COMETS], undefined, makeChainRpcs(["ethereum", "base", "arbitrum"])),
      FAMILY_BUDGET_MS,
    );

    expect(results).toHaveLength(4);
    expect(telemetry.attemptedCount).toBe(4);
    expect(telemetry.resolvedTargetCount).toBe(4);
    expect(telemetry.missingTargetCount).toBe(0);
    expect(telemetry.budgetExhausted).toBe(false);
    // Failover precedes any retry: the stalled endpoint is followed by the
    // alternate URL, and the alternate answered at least as often.
    const ethereumCalls = calls.filter((url) => url.includes(".ethereum.example.com"));
    expect(ethereumCalls[0]).toBe("https://fallback.ethereum.example.com");
    expect(ethereumCalls[1]).toBe("https://rpc.ethereum.example.com");
    expect((callsByUrl.get("https://rpc.ethereum.example.com") ?? 0))
      .toBeGreaterThanOrEqual(callsByUrl.get("https://fallback.ethereum.example.com") ?? 0);
    // The remaining targets were probed on their own chains.
    expect(callsByUrl.has("https://fallback.base.example.com")).toBe(true);
    expect(callsByUrl.has("https://rpc.arbitrum.example.com")).toBe(true);
    expect(elapsedMs).toBeLessThan(FAMILY_BUDGET_MS);
  });

  it("caps a stalled target at its share of the family budget so the remaining targets are still attempted", async () => {
    const chains = ["ethereum", "base", "arbitrum"];
    const { callsByUrl } = installRpcFetchStub({
      hangUrls: chains.flatMap((chain) => [
        `https://rpc.${chain}.example.com`,
        `https://fallback.${chain}.example.com`,
      ]),
      resolveResult: resolveCompoundResult,
    });
    const { value: { results, telemetry }, elapsedMs } = await settleWithinBudget(
      fetchCompoundV3SupplyRates([...COMPOUND_V3_COMETS], undefined, makeChainRpcs(chains)),
      FAMILY_BUDGET_MS * 2,
    );

    expect(results).toEqual([]);
    // Every target was probed; no single stalled target consumed the budget.
    expect(telemetry.attemptedCount).toBe(4);
    expect(telemetry.missingTargetCount).toBe(4);
    const stallMisses =
      (telemetry.missingReasonCounts["utilization-unavailable"] ?? 0)
      + (telemetry.missingReasonCounts["budget-exhausted"] ?? 0);
    expect(stallMisses).toBe(4);
    expect(elapsedMs).toBeLessThanOrEqual(FAMILY_BUDGET_MS + 1_000);
    for (const calls of callsByUrl.values()) {
      expect(calls).toBeGreaterThan(0);
    }
  });

  it("fails an Aave batch probe over to the alternate endpoint without dropping the window", async () => {
    const { callsByUrl } = installRpcFetchStub({
      hangUrls: ["https://fallback.ethereum.example.com"],
      resolveResult: resolveAaveResult,
    });

    const { value: { results, telemetry } } = await settleWithinBudget(
      fetchAaveV3SupplyRates(AAVE_TARGETS, undefined, makeChainRpcs(["ethereum", "base", "arbitrum"])),
      FAMILY_BUDGET_MS,
    );

    expect(telemetry.attemptedCount).toBe(6);
    expect(telemetry.resolvedTargetCount).toBe(6);
    expect(telemetry.missingTargetCount).toBe(0);
    expect(telemetry.budgetExhausted).toBe(false);
    expect(results).toHaveLength(6);
    // The ethereum probes that start on the stalled fallback URL fail over.
    expect(callsByUrl.get("https://fallback.ethereum.example.com")).toBeGreaterThan(0);
    expect(callsByUrl.has("https://rpc.ethereum.example.com")).toBe(true);
  });

  it("keeps the Aave rate math intact across the failover path", async () => {
    // A 5% RAY liquidity rate compounds to just over 5% APY; the failover must not
    // disturb the decode of the reserve struct or the aToken TVL read.
    installRpcFetchStub({
      hangUrls: ["https://fallback.ethereum.example.com"],
      resolveResult: resolveAaveResult,
    });

    const { value: { results } } = await settleWithinBudget(
      fetchAaveV3SupplyRates([AAVE_TARGETS[0]!], undefined, makeChainRpcs(["ethereum"])),
      FAMILY_BUDGET_MS,
    );

    const nominalRate = Number(RAY_FIVE_PERCENT) / 1e27;
    const expectedApy = ((1 + nominalRate / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1) * 100;
    expect(results).toHaveLength(1);
    expect(results[0]!.apy).toBeCloseTo(expectedApy, 6);
    expect(results[0]!.sourceTvlUsd).toBe(1_000_000);
  });
});
