import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRpcAuth, type ChainRpcConfig } from "../chain-registry";
import { fetchEvmRpcBatch, fetchEvmUint256AtBlock, type EvmRpcOptions } from "../evm-rpc";

const { recordCredits } = vi.hoisted(() => ({ recordCredits: vi.fn() }));
vi.mock("../rpc-provider-budget", () => ({ recordDwellirCredits: recordCredits }));

const url = "https://retry-budget.n.dwellir.com";
const calls = [{ method: "eth_call", params: [{ to: "0xToken", data: "0x18160ddd" }, "latest"] }];
type Transport = "single" | "batch" | "no-batch";

function invoke(transport: Transport, options: EvmRpcOptions) {
  const chainRpcs = options.chainRpcs ?? new Map<string, ChainRpcConfig>([["retry-test", {
    chainId: "retry-test", chainName: "Retry test", type: "evm", explorerUrl: "https://explorer.invalid",
    endpoints: [{ url, operator: "dwellir", keyed: true, position: "supplemental", stateHistory: "archive", logsHistory: "full", noBatch: transport === "no-batch" }],
  }]]);
  return transport === "single"
    ? fetchEvmUint256AtBlock("retry-test", "0xToken", "0x18160ddd", "latest", { ...options, chainRpcs })
    : fetchEvmRpcBatch("retry-test", calls, { ...options, chainRpcs });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  registerRpcAuth("dwellir", url, { "X-Api-Key": "retry-test-key" });
  recordCredits.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["single", "batch", "no-batch"] as const)("physical RPC retries: %s", (transport) => {
  function setupFetch() {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("connection reset"))
      .mockImplementation(async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body));
        const result = { jsonrpc: "2.0", id: 1, result: "0xff" };
        return Response.json(Array.isArray(payload) ? [result] : result);
      });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("keeps a supplemental provider available when the deadline expires at fetch admission", async () => {
    const chainRpcs = new Map<string, ChainRpcConfig>([["retry-test", {
      chainId: "retry-test", chainName: "Retry test", type: "evm", explorerUrl: "https://explorer.invalid",
      endpoints: [{ url, operator: "dwellir", keyed: true, position: "supplemental", stateHistory: "archive", logsHistory: "full", noBatch: transport === "no-batch" }],
    }]]);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      const result = { jsonrpc: "2.0", id: 1, result: "0x10" };
      return Response.json(Array.isArray(payload) ? [result] : result);
    });
    vi.stubGlobal("fetch", fetchMock);
    const beforeRequest = vi.fn(() => true);
    // The RPC-level deadline check passes, but the fetch-level check does not.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(2_000);
    expect(await invoke(transport, { chainRpcs, deadlineMs: 1_500, beforeRequest })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(recordCredits).not.toHaveBeenCalled();
    nowSpy.mockRestore();

    expect(await invoke(transport, { chainRpcs, beforeRequest }))
      .toEqual(transport === "single" ? 16n : ["0x10"]);
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([url]);
    expect(recordCredits.mock.calls).toEqual([[1]]);
  });

  it("keeps an untried supplemental provider available for a later admitted operation in the same run", async () => {
    const registryUrl = "https://registry.invalid";
    const chainRpcs = new Map<string, ChainRpcConfig>([["retry-test", {
      chainId: "retry-test", chainName: "Retry test", type: "evm", explorerUrl: "https://explorer.invalid",
      endpoints: [
        { url: registryUrl, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" },
        { url, operator: "dwellir", keyed: true, position: "supplemental", stateHistory: "archive", logsHistory: "full", noBatch: transport === "no-batch" },
      ],
    }]]);
    const fetchMock = vi.fn(async (requestedUrl: string, init: RequestInit) => {
      if (requestedUrl === registryUrl) return Response.json({ error: "unavailable" }, { status: 503 });
      const payload = JSON.parse(String(init.body));
      const result = { jsonrpc: "2.0", id: 1, result: "0x10" };
      return Response.json(Array.isArray(payload) ? [result] : result);
    });
    vi.stubGlobal("fetch", fetchMock);
    const beforeRequest = vi.fn((requestedUrl: string) => requestedUrl !== url);

    expect(await invoke(transport, { chainRpcs, beforeRequest, maxRetries: 0 })).toBeNull();
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([registryUrl]);
    expect(beforeRequest.mock.calls).toEqual([[registryUrl], [url]]);
    expect(recordCredits).not.toHaveBeenCalled();
    if (transport === "single") {
      expect(vi.mocked(console.warn).mock.calls.some(([message]) => String(message).includes("request admission denied"))).toBe(true);
    }

    fetchMock.mockClear();
    expect(await invoke(transport, { chainRpcs, beforeRequest: () => true, maxRetries: 0 }))
      .toEqual(transport === "single" ? 16n : ["0x10"]);
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([registryUrl, url]);
    expect(recordCredits.mock.calls).toEqual([[1]]);
  });

  it("stops the bounded operation on denial instead of trying another endpoint", async () => {
    const fetchMock = setupFetch();
    const beforeRequest = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    expect(await invoke(transport, {
      beforeRequest, extraRpcUrls: ["https://first.invalid", "https://second.invalid"],
    })).toBeNull();
    expect(beforeRequest.mock.calls).toEqual([["https://first.invalid"]]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordCredits).not.toHaveBeenCalled();
  });

  it("still demotes a provider that actually failed before its retry was denied", async () => {
    const chainRpcs = new Map<string, ChainRpcConfig>([["retry-test", {
      chainId: "retry-test", chainName: "Retry test", type: "evm", explorerUrl: "https://explorer.invalid",
      endpoints: [{ url, operator: "dwellir", keyed: true, position: "supplemental", stateHistory: "archive", logsHistory: "full", noBatch: transport === "no-batch" }],
    }]]);
    const fetchMock = setupFetch();
    const beforeRequest = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const pending = invoke(transport, { chainRpcs, beforeRequest });
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await invoke(transport, { chainRpcs, beforeRequest: () => true })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordCredits.mock.calls).toEqual([[1]]);
  });

  it("does not start an internal retry after the absolute deadline", async () => {
    const fetchMock = setupFetch();
    const beforeRequest = vi.fn(() => true);
    const pending = invoke(transport, { deadlineMs: 1_025, beforeRequest });
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(1_025);
    expect(recordCredits).toHaveBeenCalledTimes(1);
  });

  it("denies a retry when the one-request guard is exhausted", async () => {
    const fetchMock = setupFetch();
    const beforeRequest = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const pending = invoke(transport, { beforeRequest });
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(recordCredits).toHaveBeenCalledTimes(1);
  });

  it("admits and meters a successful retry independently", async () => {
    const fetchMock = setupFetch();
    const beforeRequest = vi.fn(() => true);
    const pending = invoke(transport, { deadlineMs: 5_000, beforeRequest });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(transport === "single" ? 255n : ["0xff"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(beforeRequest.mock.calls).toEqual([[url], [url]]);
    expect(recordCredits.mock.calls).toEqual([[1], [1]]);
  });
});
