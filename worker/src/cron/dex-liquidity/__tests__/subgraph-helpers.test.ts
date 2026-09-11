import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchJsonWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/fetch-retry", () => ({
  fetchJsonWithRetry: fetchJsonWithRetryMock,
}));

import { fetchSubgraphEntities, mergeDexPriceObservationMap } from "../subgraph-helpers";

describe("subgraph helpers", () => {
  beforeEach(() => {
    fetchJsonWithRetryMock.mockReset();
  });

  it("merges price observations without replacing existing rows", () => {
    const target = new Map([["usdc-circle", [{ price: 1, tvl: 100, chain: "ethereum", protocol: "curve" }]]]);
    const source = new Map([
      ["usdc-circle", [{ price: 1.001, tvl: 200, chain: "base", protocol: "aerodrome" }]],
      ["usdt-tether", [{ price: 0.999, tvl: 300, chain: "ethereum", protocol: "curve" }]],
    ]);

    mergeDexPriceObservationMap(target, source);

    expect([...target]).toEqual([
      ["usdc-circle", [
        { price: 1, tvl: 100, chain: "ethereum", protocol: "curve" },
        { price: 1.001, tvl: 200, chain: "base", protocol: "aerodrome" },
      ]],
      ["usdt-tether", [{ price: 0.999, tvl: 300, chain: "ethereum", protocol: "curve" }]],
    ]);
  });

  it("returns an empty result on non-OK subgraph responses", async () => {
    fetchJsonWithRetryMock.mockResolvedValueOnce({
      response: new Response("down", { status: 500 }),
      body: {},
    });

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
    fetchJsonWithRetryMock.mockResolvedValueOnce({
      response: new Response("", { status: 200 }),
      body: {
        data: {
          rows: [{ id: "pool-a" }],
        },
      },
    });

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

  it.each(["short-page", "http-failure", "graphql-partial"] as const)(
    "retains ordered observations across pagination: %s", async (ending) => {
      fetchJsonWithRetryMock.mockResolvedValueOnce({
        response: new Response(""), body: { data: { rows: [{ id: "a", price: 1 }, { id: "b", price: 2 }] } },
      }).mockResolvedValueOnce(ending === "http-failure"
        ? { response: new Response("", { status: 500 }), body: {} }
        : { response: new Response(""), body: {
          data: { rows: [{ id: "c", price: 3 }] },
          ...(ending === "graphql-partial" ? { errors: [{ message: "other field failed" }] } : {}),
        } });
      const result = await fetchSubgraphEntities<{ id: string; price: number }>({
        subgraphUrl: "https://subgraph.example", sourceLabel: "test", chain: "ethereum",
        pageSize: 2, maxPages: 3,
        buildQuery: (skip) => `{ rows(skip: ${skip}) { id price } }`,
        extractEntities: (data) => (data as { rows: Array<{ id: string; price: number }> }).rows,
        mapEntity: ({ id, price }) => [{
          stablecoinId: "usdc-circle", obs: { price, tvl: 100, chain: "ethereum", protocol: id },
        }],
      });
      expect(fetchJsonWithRetryMock.mock.calls.map(([, init]) => JSON.parse(init.body).query))
        .toEqual(["{ rows(skip: 0) { id price } }", "{ rows(skip: 2) { id price } }"]);
      const expected = [
        { price: 1, tvl: 100, chain: "ethereum", protocol: "a" },
        { price: 2, tvl: 100, chain: "ethereum", protocol: "b" },
        ...(ending === "http-failure" ? [] : [{ price: 3, tvl: 100, chain: "ethereum", protocol: "c" }]),
      ];
      expect(result.observations).toEqual(new Map([["usdc-circle", expected]]));
      expect(result.entityCount).toBe(ending === "http-failure" ? 2 : 3);
      expect(result.observationCount).toBe(ending === "http-failure" ? 2 : 3);
    },
  );

  it("checks for aborts between paginated subgraph fetches", async () => {
    const controller = new AbortController();
    fetchJsonWithRetryMock.mockImplementationOnce(async () => {
      controller.abort(new Error("stop paging"));
      return {
        response: new Response("", { status: 200 }),
        body: {
          data: {
            rows: [{ id: "pool-a" }],
          },
        },
      };
    });

    await expect(fetchSubgraphEntities<{ id: string }>({
      subgraphUrl: "https://subgraph.example",
      sourceLabel: "test subgraph",
      chain: "ethereum",
      pageSize: 1,
      maxPages: 2,
      signal: controller.signal,
      buildQuery: (skip) => `{ rows(skip: ${skip}) { id } }`,
      extractEntities: (data) => (data as { rows?: Array<{ id: string }> } | undefined)?.rows,
      mapEntity: () => [{
        stablecoinId: "usdc-circle",
        obs: { price: 1, tvl: 100_000, chain: "ethereum", protocol: "test" },
      }],
    })).rejects.toThrow("stop paging");

    expect(fetchJsonWithRetryMock).toHaveBeenCalledTimes(1);
  });
});
