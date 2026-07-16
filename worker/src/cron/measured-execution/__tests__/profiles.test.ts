import { describe, expect, it } from "vitest";

import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { buildDexMeasuredExecutionProfile, createDexMeasuredExecutionRpcBudget } from "../profiles";

const TARGET: DexMeasuredExecutionTarget = {
  schemaVersion: "dex-measured-target-v1",
  targetId: "target-usd1-usdc",
  stablecoinId: "usd1",
  adapterProfileId: "uniswap-v3-quoter-v2",
  protocol: "uniswap-v3",
  chain: "ethereum",
  poolId: "0x1111111111111111111111111111111111111111",
  tokenIn: {
    address: "0x2222222222222222222222222222222222222222",
    symbol: "USD1",
    decimals: 6,
    referencePriceUsd: 1,
    trackedAssetId: "usd1",
  },
  tokenOut: {
    address: "0x3333333333333333333333333333333333333333",
    symbol: "USDC",
    decimals: 6,
    referencePriceUsd: 1,
    trackedAssetId: "usdc-circle",
  },
  feePips: 100,
  retainedTvlUsd: 1_000_000,
  retainedPoolPriceUsd: 1,
  capturedAt: 1_000,
};

describe("measured execution RPC budget", () => {
  it("hard-stops actual request attempts at the configured count", () => {
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 2,
      deadlineMs: 10_000,
      now: () => 1_000,
    });

    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.requestsUsed).toBe(2);
    expect(budget.stopReason).toBe("request-budget-exhausted");
  });

  it("opens one chain circuit after two consecutive transport failures", () => {
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 10,
      deadlineMs: 10_000,
      now: () => 1_000,
    });

    budget.recordChainResult("Ethereum", false);
    expect(budget.canRequestChain("ethereum")).toBe(true);
    budget.recordChainResult("ethereum", false);

    expect(budget.canRequestChain("ethereum")).toBe(false);
    expect(budget.isChainCircuitOpen("ETHEREUM")).toBe(true);
    expect(budget.canRequestChain("base")).toBe(true);
    expect(budget.openChains).toEqual(["ethereum"]);
  });

  it("resets consecutive failures after a successful chain request", () => {
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 10,
      deadlineMs: 10_000,
      now: () => 1_000,
    });

    budget.recordChainResult("base", false);
    budget.recordChainResult("base", true);
    budget.recordChainResult("base", false);

    expect(budget.canRequestChain("base")).toBe(true);
    expect(budget.openChains).toEqual([]);
  });
});

describe("measured execution profile construction", () => {
  it("preserves a deterministic marginal revert as measured zero capacity", () => {
    const profile = buildDexMeasuredExecutionProfile({
      target: TARGET,
      targetGenerationId: "targets-1",
      quoteGenerationId: "quotes-1",
      quotedAt: 1_100,
      blockNumber: 123,
      endpointAddress: "0x4444444444444444444444444444444444444444",
      endpointCodeHash: `0x${"ab".repeat(32)}`,
      points: [{
        amountInRaw: "1000000000",
        amountOutRaw: "0",
        callData: "0x1234",
        returnData: "0x",
        inputUsd: 1_000,
        outputUsd: 0,
        costBps: 10_000,
        passesCostBound: false,
        reverted: true,
        adapterMetadata: { executionReverted: true },
      }],
    });

    expect(profile.quoteProof).toEqual([
      expect.objectContaining({ reverted: true, amountOutRaw: "0", returnData: "0x" }),
    ]);
    expect(profile.marginalOutputRatio).toBe(0);
    expect(profile.capacityCurve.every((point) => point.executableUsd === 0)).toBe(true);
  });
});
