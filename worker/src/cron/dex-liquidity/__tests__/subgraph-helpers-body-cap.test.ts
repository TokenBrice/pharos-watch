import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
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
