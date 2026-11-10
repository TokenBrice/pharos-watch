import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { SUBGRAPH_PER_CHAIN_TIMEOUT_MS } from "../constants";
import { fetchSubgraphEntities } from "../subgraph-helpers";

/**
 * A page whose body streams past the cap while its declared length stays
 * unknown. The capped reader must abort it instead of buffering and parsing it.
 */
function oversizedJsonResponse(padBytes: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // A syntactically valid prefix would parse into rows if the cap were not
      // enforced; the page must never contribute any of them.
      controller.enqueue(encoder.encode('{"data":{"pools":[{"id":"0xpool-affordable"}]},"pad":"'));
      controller.enqueue(encoder.encode("x".repeat(padBytes)));
      controller.enqueue(encoder.encode('"}'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("subgraph page body cap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails the source as body-over-cap without emitting partial rows", async () => {
    mockFetch(
      [{ match: "subgraph.example", respond: () => oversizedJsonResponse(4096) }],
      { requireMatch: true },
    );

    const result = await fetchSubgraphEntities({
      subgraphUrl: "https://subgraph.example",
      sourceLabel: "test subgraph",
      chain: "ethereum",
      buildQuery: () => "{ pools { id } }",
      extractEntities: (data) => (data as { pools?: { id: string }[] } | undefined)?.pools,
      mapEntity: (entity) => [{ stablecoinId: entity.id, obs: { price: 1, tvl: 1, chain: "ethereum", protocol: "uniswap-v3" } }],
      maxResponseBytes: 1024,
      errorHandling: { warnOnFetchFailure: false, warnOnGraphQlErrors: false },
    });

    expect(result.failed).toBe(true);
    expect(result.failureReason).toBe("body-over-cap");
    expect(result.entityCount).toBe(0);
    expect(result.observationCount).toBe(0);
    expect(result.observations.size).toBe(0);
    expect(result.shouldLogIndex).toBe(false);
  });

  it("keeps an in-cap page working under the same options", async () => {
    mockFetch(
      [{
        match: "subgraph.example",
        respond: () => new Response(JSON.stringify({ data: { pools: [{ id: "usdc-circle" }] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      }],
      { requireMatch: true },
    );

    const result = await fetchSubgraphEntities({
      subgraphUrl: "https://subgraph.example",
      sourceLabel: "test subgraph",
      chain: "ethereum",
      buildQuery: () => "{ pools { id } }",
      extractEntities: (data) => (data as { pools?: { id: string }[] } | undefined)?.pools,
      mapEntity: (entity) => [{ stablecoinId: entity.id, obs: { price: 1, tvl: 1, chain: "ethereum", protocol: "uniswap-v3" } }],
      maxResponseBytes: 1024,
      errorHandling: { warnOnFetchFailure: false, warnOnGraphQlErrors: false },
    });

    expect(result.failed).toBe(false);
    expect(result.failureReason).toBeUndefined();
    expect(result.entityCount).toBe(1);
    expect([...result.observations.keys()]).toEqual(["usdc-circle"]);
  });
});

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
