import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig, RpcEndpoint } from "../../../lib/chain-registry";
import { registryRpcEndpoint } from "../../../test-helpers/chain-rpc-fixtures.test-support";
import { createOptionalSourceBudget, resolveRpcUrls, runTimedOptionalSource } from "../sources-rpc";

function supplementalEndpoint(url: string): RpcEndpoint {
  return {
    url,
    operator: "dwellir",
    keyed: true,
    position: "supplemental",
    stateHistory: "archive",
    logsHistory: "full",
    verifiedAt: "2026-09-23",
  };
}

function makeRpc(overrides: Partial<ChainRpcConfig> = {}): ChainRpcConfig {
  return {
    chainId: "ethereum",
    chainName: "Ethereum",
    type: "evm",
    endpoints: [
      registryRpcEndpoint("https://rpc.example.com"),
      registryRpcEndpoint("https://fallback.example.com"),
    ],
    explorerUrl: "https://etherscan.io",
    ...overrides,
  };
}

describe("resolveRpcUrls", () => {
  it("prefers the fallback URL by default and drops the missing side", () => {
    expect(resolveRpcUrls(makeRpc())).toEqual([
      "https://fallback.example.com",
      "https://rpc.example.com",
    ]);
    expect(resolveRpcUrls(makeRpc({ endpoints: [registryRpcEndpoint("https://rpc.example.com")] }))).toEqual([
      "https://rpc.example.com",
    ]);
    expect(
      resolveRpcUrls(
        makeRpc({
          endpoints: [
            registryRpcEndpoint(""),
            registryRpcEndpoint("https://fallback.example.com"),
          ],
        }),
      ),
    ).toEqual(["https://fallback.example.com"]);
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
    const rpc = makeRpc({
      endpoints: [
        registryRpcEndpoint("https://rpc.example.com"),
        registryRpcEndpoint("https://rpc.example.com"),
      ],
    });
    expect(resolveRpcUrls(rpc)).toEqual(["https://rpc.example.com"]);
    expect(resolveRpcUrls(rpc, { order: "primary-first" })).toEqual(["https://rpc.example.com"]);
    expect(resolveRpcUrls(rpc, { order: "rotate", seed: 1 })).toEqual(["https://rpc.example.com"]);
  });

  it("excludes promoted Dwellir without displacing either incumbent URL", () => {
    const rpc = makeRpc();
    const promoted = { ...supplementalEndpoint("https://dwellir.example"), position: "registry" as const };
    for (const index of [0, 1]) {
      const endpoints = [...rpc.endpoints];
      endpoints.splice(index, 0, promoted);
      expect(resolveRpcUrls(makeRpc({ endpoints }))).toEqual(resolveRpcUrls(rpc));
      expect(resolveRpcUrls(makeRpc({ endpoints }), { order: "primary-first" }))
        .toEqual(resolveRpcUrls(rpc, { order: "primary-first" }));
    }
  });

  it("ignores a trailing supplemental endpoint in every order", () => {
    const withDwellir = makeRpc({
      endpoints: [
        registryRpcEndpoint("https://rpc.example.com"),
        registryRpcEndpoint("https://fallback.example.com"),
        supplementalEndpoint("https://api-ethereum-mainnet.n.dwellir.com"),
      ],
    });

    expect(resolveRpcUrls(withDwellir)).toEqual(resolveRpcUrls(makeRpc()));
    expect(resolveRpcUrls(withDwellir, { order: "primary-first" })).toEqual([
      "https://rpc.example.com",
      "https://fallback.example.com",
    ]);
    expect(resolveRpcUrls(withDwellir, { order: "rotate", seed: 1 })).toEqual([
      "https://rpc.example.com",
      "https://fallback.example.com",
    ]);
    expect(resolveRpcUrls(withDwellir)).not.toContain("https://api-ethereum-mainnet.n.dwellir.com");
    // A supplemental-only config (pin-only chain + Dwellir key) has no readable
    // registry URL at all.
    expect(
      resolveRpcUrls(
        makeRpc({ endpoints: [supplementalEndpoint("https://api-base-mainnet-archive.n.dwellir.com")] }),
      ),
    ).toEqual([]);
  });
});

describe("createOptionalSourceBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

describe("runTimedOptionalSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["throw", "null", "abort"] as const)("isolates %s with one outcome only for a source exception", async (mode) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onOutcome = vi.fn();
    const parent = new AbortController();
    const error = new Error("reader failed");
    const result = runTimedOptionalSource("fixture source", parent.signal, async (signal) => {
      if (mode === "null") return null;
      if (mode === "abort") parent.abort(error);
      expect(signal.aborted).toBe(mode === "abort");
      throw error;
    }, null, onOutcome);
    if (mode === "abort") await expect(result).rejects.toBe(error);
    else await expect(result).resolves.toBeNull();
    expect(onOutcome.mock.calls).toEqual(mode === "throw" ? [[{ label: "fixture source", outcome: "failed" }]] : []);
    expect(warn).toHaveBeenCalledTimes(mode === "throw" ? 1 : 0);
    if (mode === "throw") expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
      event: "optional_yield_source_failed", job: "sync-yield-data", source: "fixture source", errorMessage: error.message,
    });
  });

  it("reports an exhausted source budget once without aborting its parent", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onOutcome = vi.fn();
    const parent = new AbortController();
    const result = runTimedOptionalSource("fixture source", parent.signal, (signal) =>
      new Promise<null>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    null, onOutcome);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(result).resolves.toBeNull();
    expect(parent.signal.aborted).toBe(false);
    expect(onOutcome.mock.calls).toEqual([[{ label: "fixture source", outcome: "timeout" }]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
