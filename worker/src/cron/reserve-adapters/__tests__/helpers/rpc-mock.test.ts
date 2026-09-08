import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FetchRetry from "../../../../lib/fetch-retry";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { fetchWithRetryMock, getChainRpcMock, resetRpcMocks, testChainRpcs } from "./rpc-mock";

beforeEach(resetRpcMocks);
afterEach(() => vi.unstubAllGlobals());

describe("RPC fixture lifetime", () => {
  it("discards queued responses and implementations on reset", async () => {
    getChainRpcMock.mockReturnValueOnce({ rpcUrl: "stale" });
    fetchWithRetryMock.mockResolvedValueOnce(new Response("stale"));
    fetchWithRetryMock.mockImplementation(async () => new Response("old default"));
    resetRpcMocks();
    expect(getChainRpcMock(testChainRpcs, "ethereum")?.rpcUrl).toBe("https://rpc.example");
    expect(await fetchWithRetryMock()).toBeUndefined();
    fetchWithRetryMock.mockResolvedValueOnce(new Response("new"));
    await expect((await fetchWithRetryMock()).text()).resolves.toBe("new");
  });

  it("restores map entries and nested config mutations", () => {
    testChainRpcs.get("ethereum")!.rpcUrl = "https://stale.example";
    testChainRpcs.set("extra", { ...testChainRpcs.get("ethereum")!, chainId: "extra" });
    resetRpcMocks();
    expect(testChainRpcs.has("extra")).toBe(false);
    expect(getChainRpcMock(testChainRpcs, "ethereum")?.rpcUrl).toBe("https://rpc.example");
  });

  it("returns null for malformed JSON rather than a parser exception", async () => {
    // Load after rpc-mock registers its transport seam.
    const { fetchJsonWithRetry } = await import("../../../../lib/fetch-retry");
    fetchWithRetryMock.mockResolvedValueOnce(new Response("{"));
    await expect(fetchJsonWithRetry("https://rpc.example", undefined, 0)).resolves.toBeNull();
  });

  it("honors caller cancellation before consuming a body", async () => {
    // Load after rpc-mock registers its transport seam.
    const { fetchTextWithRetry } = await import("../../../../lib/fetch-retry");
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    fetchWithRetryMock.mockResolvedValueOnce(new Response("late"));
    await expect(fetchTextWithRetry("https://rpc.example", { signal: controller.signal }, 0)).rejects.toBe(reason);
  });
});

describe("production body helpers over mocked transport", () => {
  it("exhausts malformed JSON to null and preserves cancellation", async () => {
    const actual = await vi.importActual<typeof FetchRetry>("../../../../lib/fetch-retry");
    mockFetch([{ match: "https://rpc.example", body: "{" }]);
    await expect(actual.fetchJsonWithRetry("https://rpc.example", undefined, 0)).resolves.toBeNull();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    await expect(actual.fetchTextWithRetry("https://rpc.example", { signal: controller.signal }, 0)).rejects.toBe(reason);
  });
});
