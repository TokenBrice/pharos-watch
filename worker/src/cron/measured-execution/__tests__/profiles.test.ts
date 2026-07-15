import { describe, expect, it } from "vitest";

import { createDexMeasuredExecutionRpcBudget } from "../profiles";

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
