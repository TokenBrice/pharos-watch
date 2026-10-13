import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { SUBGRAPH_PER_CHAIN_TIMEOUT_MS } from "../constants";
import { fetchSubgraphEntities } from "../subgraph-helpers";

describe("subgraph request deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const signal = init.signal!;
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve(Response.json({ data: { pools: [{ id: "pool" }] } }));
      }, 20_000);
      signal.addEventListener("abort", abort, { once: true });
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function fetchPages(maxPages: number) {
    const timeout = createTimeoutSignal({
      timeoutMs: SUBGRAPH_PER_CHAIN_TIMEOUT_MS,
      timeoutReason: new DOMException("chain deadline", "TimeoutError"),
    });
    return fetchSubgraphEntities<{ id: string }>({
      subgraphUrl: "https://subgraph.example",
      sourceLabel: "test subgraph",
      chain: "ethereum",
      signal: timeout.signal,
      pageSize: 1,
      maxPages,
      buildQuery: (skip) => `{ pools(first: 1, skip: ${skip}) { id } }`,
      extractEntities: (data) => (data as { pools: { id: string }[] }).pools,
      mapEntity: () => [],
    }).finally(() => timeout.dispose());
  }

  it("admits a response after 15 seconds within the configured chain deadline", async () => {
    const result = fetchPages(1);
    const assertion = expect(result).resolves.toMatchObject({ entityCount: 1, failed: false });
    await vi.advanceTimersByTimeAsync(SUBGRAPH_PER_CHAIN_TIMEOUT_MS);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the original chain deadline across later pages", async () => {
    const result = fetchPages(2);
    const assertion = expect(result).rejects.toThrow("chain deadline");
    await vi.advanceTimersByTimeAsync(SUBGRAPH_PER_CHAIN_TIMEOUT_MS);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
