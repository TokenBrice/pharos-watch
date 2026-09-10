import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPancakeSwapPools } from "../fetch-pancakeswap";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const BSC_SUBGRAPH_ID = "Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ";
const ETHEREUM_SUBGRAPH_ID = "CJYGNhb7RvnhfBDjqpRnD3oxgyhibzc7fkAMa38YV3oS";
const BASE_SUBGRAPH_ID = "BHWNsedAHtmTCzXxCCDfhPmm6iN9rxUhoRHdHKyujic3";
const STORED_CURSOR = "250";

interface RecordedPaginationWrite {
  sourceKey: string;
  cursor: string | null;
  completed: boolean;
  pagesFetched: number;
  diagnostics: string[];
}

function makePaginationWriteD1(writes: RecordedPaginationWrite[]) {
  return makeNoopD1({
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () =>
          query.includes("dex_source_pagination_state")
            ? {
                cursor: STORED_CURSOR,
                cycle_started_at: null,
                updated_at: null,
                completed_at: null,
                pages_fetched: 0,
              }
            : null,
        run: async () => {
          writes.push({
            sourceKey: String(args[0]),
            cursor: args[1] == null ? null : String(args[1]),
            completed: args[4] != null,
            pagesFetched: Number(args[5] ?? 0),
            diagnostics: JSON.parse(String(args[6] ?? "[]")) as string[],
          });
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }),
  });
}

function poolsResponse(pools: unknown[]): Response {
  return new Response(JSON.stringify({ data: { pools } }), { status: 200 });
}

function hourDataResponse(): Response {
  return new Response(JSON.stringify({ data: { poolHourDatas: [] } }), { status: 200 });
}

function hangUntilAbort(init: RequestInit | undefined): Promise<Response> {
  const signal = init?.signal;
  return new Promise<Response>((_resolve, reject) => {
    if (!signal) {
      reject(new Error("fetch was called without an abort signal"));
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

function makePool(id: string) {
  return {
    id,
    feeTier: "100",
    totalValueLockedUSD: "125000",
    totalValueLockedToken0: "62500",
    totalValueLockedToken1: "62500",
    token0Price: "1",
    token1Price: "1",
    token0: { id: `${id}-usdc`, symbol: "USDC", decimals: "6" },
    token1: { id: `${id}-usdt`, symbol: "USDT", decimals: "6" },
  };
}

describe("fetchPancakeSwapPools per-attempt retries and chain progress", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries one timed-out attempt and still returns that chain's pools", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    let bscHeadAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (String(init?.body).includes("poolHourDatas")) return hourDataResponse();
      const isBsc = url.includes(BSC_SUBGRAPH_ID);
      if (isBsc) {
        bscHeadAttempts += 1;
        if (bscHeadAttempts === 1) return await hangUntilAbort(init);
      }
      return poolsResponse(isBsc ? [makePool("0xbsc-pool")] : []);
    }));

    const writes: RecordedPaginationWrite[] = [];
    const pending = fetchPancakeSwapPools("graph-key", undefined, makePaginationWriteD1(writes));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    // A pre-armed outer abort used to rethrow after attempt 1, so the retry never
    // ran and BSC reported no pools at all.
    expect(bscHeadAttempts).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(result.pools.map((pool) => pool.chain)).toEqual(["bsc"]);
    expect(writes.map((write) => write.sourceKey)).toEqual([
      "pancakeswap-v3:bsc",
      "pancakeswap-v3:ethereum",
      "pancakeswap-v3:base",
    ]);
  });

  it("keeps healthy chains and persists per-chain progress when one chain fails every attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    let bscHeadAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (String(init?.body).includes("poolHourDatas")) return hourDataResponse();
      if (url.includes(BSC_SUBGRAPH_ID)) {
        bscHeadAttempts += 1;
        return await hangUntilAbort(init);
      }
      if (url.includes(ETHEREUM_SUBGRAPH_ID)) return poolsResponse([makePool("0xeth-pool")]);
      if (url.includes(BASE_SUBGRAPH_ID)) return poolsResponse([makePool("0xbase-pool")]);
      return poolsResponse([]);
    }));

    const writes: RecordedPaginationWrite[] = [];
    const pending = fetchPancakeSwapPools("graph-key", undefined, makePaginationWriteD1(writes));
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(bscHeadAttempts).toBe(3);
    expect(result.pools.map((pool) => pool.chain)).toEqual(["ethereum", "base"]);
    expect(result.degraded).toBe(true);
    expect(result.degradedChains).toEqual(["bsc"]);
    expect(result.errors.join(" ")).toContain("bsc:");
    expect(result.errors.join(" ")).toContain("timed out");

    // The failed chain still writes its own row: its cursor advances past the page
    // it died on instead of freezing at the stored 250 forever.
    expect(writes.map((write) => write.sourceKey)).toEqual([
      "pancakeswap-v3:bsc",
      "pancakeswap-v3:ethereum",
      "pancakeswap-v3:base",
    ]);
    expect(writes[0]).toMatchObject({ cursor: "500", completed: false, pagesFetched: 0 });
    expect(writes[0]!.diagnostics.join(" ")).toContain("bsc failure:");
    expect(writes.slice(1).map((write) => write.cursor)).toEqual(["250", "250"]);
    expect(writes.slice(1).every((write) => write.completed)).toBe(true);
  });
});
