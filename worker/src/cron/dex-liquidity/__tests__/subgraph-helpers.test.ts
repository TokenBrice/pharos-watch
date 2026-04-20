import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
}));

import { fetchSubgraphEntities, mergePriceObservations } from "../subgraph-helpers";

describe("subgraph helpers", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  it("merges price observations without replacing existing rows", () => {
    const target = new Map([["usdc-circle", [{ price: 1, tvl: 100, chain: "ethereum", protocol: "curve" }]]]);
    const source = new Map([["usdc-circle", [{ price: 1.001, tvl: 200, chain: "base", protocol: "aerodrome" }]]]);

    mergePriceObservations(target, source);

    expect(target.get("usdc-circle")).toHaveLength(2);
  });

  it("returns an empty result on non-OK subgraph responses", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(new Response("down", { status: 500 }));

    const result = await fetchSubgraphEntities({
      subgraphUrl: "https://subgraph.example",
      sourceLabel: "test subgraph",
      chain: "ethereum",
      buildQuery: () => "{ pools { id } }",
      extractEntities: () => [],
      mapEntity: () => [],
      errorHandling: { warnOnFetchFailure: false },
    });

    expect(result).toEqual({
      entityCount: 0,
      observationCount: 0,
      observations: new Map(),
      shouldLogIndex: false,
    });
  });

  it("maps entities into observations and stops on short final page", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: {
        rows: [{ id: "pool-a" }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await fetchSubgraphEntities<{ id: string }>({
      subgraphUrl: "https://subgraph.example",
      sourceLabel: "test subgraph",
      chain: "ethereum",
      pageSize: 10,
      maxPages: 2,
      buildQuery: (skip) => `{ rows(skip: ${skip}) { id } }`,
      extractEntities: (data) => (data as { rows?: Array<{ id: string }> } | undefined)?.rows,
      mapEntity: () => [{
        stablecoinId: "usdc-circle",
        obs: { price: 1, tvl: 100_000, chain: "ethereum", protocol: "test" },
      }],
    });

    expect(result.entityCount).toBe(1);
    expect(result.observationCount).toBe(1);
    expect(result.shouldLogIndex).toBe(true);
    expect(result.observations.get("usdc-circle")).toHaveLength(1);
  });
});
