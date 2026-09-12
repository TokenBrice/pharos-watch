import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import {
  createOptionalSourceBudget,
  resolveCanonicalChain,
  resolveRpcUrls,
} from "../sources-helpers";

function makeRpc(overrides: Partial<ChainRpcConfig> = {}): ChainRpcConfig {
  return {
    chainId: "ethereum",
    chainName: "Ethereum",
    type: "evm",
    rpcUrl: "https://rpc.example.com",
    fallbackRpcUrl: "https://fallback.example.com",
    explorerUrl: "https://etherscan.io",
    ...overrides,
  };
}

describe("resolveCanonicalChain", () => {
  it("preserves alias and unknown-id behavior for yield sources", () => {
    expect(resolveCanonicalChain(" Ethereum ")).toBe("ethereum");
    expect(resolveCanonicalChain(1)).toBe("ethereum");
    expect(resolveCanonicalChain(999_999)).toBe("999999");
    expect(resolveCanonicalChain("   ")).toBeNull();
  });
});

describe("resolveRpcUrls", () => {
  it("prefers the fallback URL by default and drops the missing side", () => {
    expect(resolveRpcUrls(makeRpc())).toEqual([
      "https://fallback.example.com",
      "https://rpc.example.com",
    ]);
    expect(resolveRpcUrls(makeRpc({ fallbackRpcUrl: undefined }))).toEqual([
      "https://rpc.example.com",
    ]);
    expect(resolveRpcUrls(makeRpc({ rpcUrl: "" }))).toEqual(["https://fallback.example.com"]);
    expect(resolveRpcUrls(undefined)).toEqual([]);
  });

  it("honours primary-first ordering", () => {
    expect(resolveRpcUrls(makeRpc(), { order: "primary-first" })).toEqual([
      "https://rpc.example.com",
      "https://fallback.example.com",
    ]);
  });

  it("rotates by seed parity so retries alternate the first endpoint", () => {
    const rpc = makeRpc();
    expect(resolveRpcUrls(rpc, { order: "rotate", seed: 0 })).toEqual([
      "https://fallback.example.com",
      "https://rpc.example.com",
    ]);
    expect(resolveRpcUrls(rpc, { order: "rotate", seed: 1 })).toEqual([
      "https://rpc.example.com",
      "https://fallback.example.com",
    ]);
    expect(resolveRpcUrls(rpc, { order: "rotate", seed: 2 })).toEqual([
      "https://fallback.example.com",
      "https://rpc.example.com",
    ]);
    expect(resolveRpcUrls(rpc, { order: "rotate" })).toEqual([
      "https://fallback.example.com",
      "https://rpc.example.com",
    ]);
  });

  it("deduplicates a primary that repeats the fallback URL in every order", () => {
    const rpc = makeRpc({ fallbackRpcUrl: "https://rpc.example.com" });
    expect(resolveRpcUrls(rpc)).toEqual(["https://rpc.example.com"]);
    expect(resolveRpcUrls(rpc, { order: "primary-first" })).toEqual(["https://rpc.example.com"]);
    expect(resolveRpcUrls(rpc, { order: "rotate", seed: 1 })).toEqual(["https://rpc.example.com"]);
  });
});

describe("createOptionalSourceBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes the budget controller directly when no caller signal is supplied", () => {
    const budget = createOptionalSourceBudget("fixture source", 30_000);
    expect(budget.signal).toBe(budget.budgetController.signal);
    expect(budget.signal.aborted).toBe(false);
    budget.cleanup();
  });

  it("aborts with the label and elapsed budget once the timeout fires", async () => {
    const budget = createOptionalSourceBudget("Aave V3 supply rates", 25_000);

    await vi.advanceTimersByTimeAsync(24_999);
    expect(budget.budgetController.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(budget.budgetController.signal.aborted).toBe(true);
    expect(budget.signal.aborted).toBe(true);
    expect((budget.budgetController.signal.reason as Error).message).toBe(
      "Aave V3 supply rates budget exhausted after 25s",
    );
    budget.cleanup();
  });

  it("propagates a caller abort without aborting the budget controller", () => {
    const external = new AbortController();
    const budget = createOptionalSourceBudget("fixture source", 30_000, external.signal);

    expect(budget.signal).not.toBe(external.signal);
    external.abort(new Error("run cancelled"));

    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toEqual(new Error("run cancelled"));
    // The caller's abort is not the budget's own failure, so the budget signal
    // stays clean for the code that inspects it for exhaustion.
    expect(budget.budgetController.signal.aborted).toBe(false);
    budget.cleanup();
  });

  it("cleanup cancels the pending timeout so the budget never aborts", async () => {
    const budget = createOptionalSourceBudget("fixture source", 30_000);
    budget.cleanup();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(budget.budgetController.signal.aborted).toBe(false);
    expect(budget.signal.aborted).toBe(false);
  });
});
