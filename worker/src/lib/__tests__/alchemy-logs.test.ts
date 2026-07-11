import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAlchemyUrl,
  getAlchemyBlockNumber,
  getAlchemyTransactionContextBatchMany,
  fetchAlchemyLogs,
  resolveBlockTimestamps,
} from "../alchemy-logs";
import { createBudget } from "../evm-logs";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function makeLog(txHash: string, blockNumber = 0x176f050) {
  return {
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    topics: ["0xddf252ad...", "0x0000..."],
    data: "0x00000000000000000000000000000000000000000000000000000002540be400",
    blockNumber: "0x" + blockNumber.toString(16),
    transactionHash: txHash,
    transactionIndex: "0x0",
    blockHash: "0xdef456",
    logIndex: "0x0",
    removed: false,
  };
}

function makeDbForTimestampCache(
  opts: {
    cachedRows?: Array<{ block_number: number; timestamp: number }>;
    onBatchWrite?: (count: number) => void;
    onCacheReadBindCount?: (count: number) => void;
  } = {},
): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => {
        if (sql.includes("FROM block_timestamp_cache")) {
          opts.onCacheReadBindCount?.(_args.length);
        }
        return {
          all: async <T>() => ({
            results: (sql.includes("FROM block_timestamp_cache") ? (opts.cachedRows ?? []) : []) as T[],
            success: true,
            meta: {},
          }),
          first: async <T>() => null as T | null,
          run: async () => ({ success: true, meta: { changes: 1 } }),
        };
      },
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
      first: async <T>() => null as T | null,
      run: async () => ({ success: true, meta: { changes: 1 } }),
    }),
    batch: async (stmts: unknown[]) => {
      opts.onBatchWrite?.(stmts.length);
      return [] as unknown[];
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

// --- buildAlchemyUrl ---

describe("buildAlchemyUrl", () => {
  it("builds correct URL for known chains", () => {
    expect(buildAlchemyUrl("ethereum", "test-key")).toBe("https://eth-mainnet.g.alchemy.com/v2/test-key");
    expect(buildAlchemyUrl("base", "test-key")).toBe("https://base-mainnet.g.alchemy.com/v2/test-key");
    expect(buildAlchemyUrl("avalanche", "test-key")).toBe("https://avax-mainnet.g.alchemy.com/v2/test-key");
  });

  it("returns null for unknown chains", () => {
    expect(buildAlchemyUrl("tron", "test-key")).toBeNull();
    expect(buildAlchemyUrl("solana", "test-key")).toBeNull();
  });
});

// --- getAlchemyBlockNumber ---

describe("getAlchemyBlockNumber", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("returns block number from JSON-RPC response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x176f12d" }), { status: 200 }),
    );

    const budget = createBudget(100);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);

    expect(result).toBe(0x176f12d);
    expect(budget.count).toBe(1);
  });

  it("returns null on 5xx HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));

    const budget = createBudget(100);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);

    expect(result).toBeNull();
    expect(budget.count).toBe(1);
  });

  it("returns null when budget exhausted", async () => {
    const budget = createBudget(0);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchAlchemyLogs runtime deadline", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("does not start eth_getLogs when the run deadline is already exhausted", async () => {
    const budget = createBudget(10);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      [{ index: 0, value: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" }],
      22_000_000,
      22_000_100,
      budget,
      undefined,
      { deadlineMs: Date.now() - 1 },
    );

    expect(result).toMatchObject({
      logs: [],
      complete: false,
      scannedToBlock: 21_999_999,
      calls: 0,
    });
    expect(budget.count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- getAlchemyTransactionContextBatchMany ---

describe("getAlchemyTransactionContextBatchMany", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("batches transaction and receipt lookups into one HTTP request", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 0, result: { hash: "0xaaa", to: "0xrouter", input: "0x12345678" } },
          { jsonrpc: "2.0", id: 1, result: { transactionHash: "0xaaa", to: "0xrouter", logs: [] } },
          { jsonrpc: "2.0", id: 2, result: { hash: "0xbbb", to: "0xrouter", input: "0x87654321" } },
          { jsonrpc: "2.0", id: 3, result: { transactionHash: "0xbbb", to: "0xrouter", logs: [] } },
        ]),
        { status: 200 },
      ),
    );

    const budget = createBudget(100);
    const result = await getAlchemyTransactionContextBatchMany(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      ["0xaaa", "0xbbb"],
      budget,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(budget.count).toBe(1);
    expect(result.get("0xaaa")?.tx?.hash).toBe("0xaaa");
    expect(result.get("0xbbb")?.receipt?.transactionHash).toBe("0xbbb");
  });

  it("returns null contexts without fetching when budget is exhausted", async () => {
    const budget = createBudget(0);
    const result = await getAlchemyTransactionContextBatchMany(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      ["0xaaa"],
      budget,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.get("0xaaa")).toEqual({ tx: null, receipt: null });
  });
});

// --- fetchAlchemyLogs ---

describe("fetchAlchemyLogs", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("returns parsed log entries on success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [makeLog("0xabc123")] }), { status: 200 }),
    );

    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      [{ index: 0, value: "0xddf252ad..." }],
      0x176f000,
      0x176f100,
      budget,
    );

    expect(result).not.toBeNull();
    expect(result?.complete).toBe(true);
    expect(result?.scannedToBlock).toBe(0x176f100);
    expect(result?.logs).toHaveLength(1);
    expect(result?.logs[0].transactionHash).toBe("0xabc123");
    expect(budget.count).toBe(1);
  });

  it("returns incomplete coverage when budget is exhausted before the call starts", async () => {
    const budget = createBudget(0);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract",
      [{ index: 0, value: "0xtopic" }],
      100,
      200,
      budget,
    );

    expect(result).toEqual({
      logs: [],
      complete: false,
      scannedToBlock: 99,
      calls: 0,
      maxDepth: 0,
      failureReason: "subrequest-budget-exhausted",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds recursive split calls independently of the global subrequest budget", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32005, message: "block range is too wide" },
          }),
          { status: 400 },
        ),
    );

    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract",
      [{ index: 0, value: ["0xtopic-a", "0xtopic-b"] }],
      100,
      10_000,
      budget,
      undefined,
      { maxSplitCalls: 2 },
    );

    expect(result).toMatchObject({
      complete: false,
      scannedToBlock: 99,
      calls: 2,
      failureReason: "split-call-cap",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(budget.count).toBe(2);
  });

  it("passes OR-topic arrays through to eth_getLogs", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 }),
    );

    await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract",
      [{ index: 0, value: ["0xtopic-a", "0xtopic-b"] }],
      100,
      200,
      createBudget(10),
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { params: Array<{ topics: unknown[] }> };
    expect(body.params[0]?.topics[0]).toEqual(["0xtopic-a", "0xtopic-b"]);
  });

  it("splits range on retryable provider error", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32005, message: "block range is too wide" },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [makeLog("0xleft")] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [makeLog("0xright", 0x176f051)] }), {
          status: 200,
        }),
      );

    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract",
      [{ index: 0, value: "0xtopic" }],
      100,
      200,
      budget,
    );

    expect(result).not.toBeNull();
    expect(result?.complete).toBe(true);
    expect(result?.scannedToBlock).toBe(200);
    expect(result?.logs).toHaveLength(2);
    expect(result?.maxDepth).toBeGreaterThan(0);
  });

  it("returns partial result when one split branch fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32005, message: "block range is too wide" },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [makeLog("0xleft")] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32602, message: "invalid filter" },
          }),
          { status: 400 },
        ),
      );

    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract",
      [{ index: 0, value: "0xtopic" }],
      100,
      200,
      budget,
    );

    expect(result).not.toBeNull();
    expect(result?.complete).toBe(false);
    expect(result?.scannedToBlock).toBe(150);
    expect(result?.logs).toHaveLength(1);
  });

  it("processes split branches sequentially to avoid concurrent log fan-out", async () => {
    let releaseLeft!: () => void;
    let markLeftStarted!: () => void;
    const leftStarted = new Promise<void>((resolve) => {
      markLeftStarted = resolve;
    });

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32005, message: "block range is too wide" },
          }),
          { status: 400 },
        ),
      )
      .mockImplementationOnce(async () => {
        markLeftStarted();
        await new Promise<void>((resolve) => {
          releaseLeft = resolve;
        });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [makeLog("0xleft")] }), { status: 200 });
      })
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [makeLog("0xright", 0x176f051)] }), {
          status: 200,
        }),
      );

    const budget = createBudget(100);
    const pending = fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract",
      [{ index: 0, value: "0xtopic" }],
      100,
      200,
      budget,
    );

    await leftStarted;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    releaseLeft();
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result?.complete).toBe(true);
    expect(result?.scannedToBlock).toBe(200);
    expect(result?.logs).toHaveLength(2);
  });

  it("builds correct sparse topic array for multi-topic filters", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 }),
    );

    const budget = createBudget(100);
    await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract",
      [
        { index: 0, value: "0xddf252ad..." },
        { index: 2, value: "0x0000000000000000000000000000000000000000000000000000000000000000" },
      ],
      100,
      200,
      budget,
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params[0].topics).toEqual([
      "0xddf252ad...",
      null,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ]);
  });
});

// --- resolveBlockTimestamps ---

describe("resolveBlockTimestamps", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("batch-fetches timestamps for multiple blocks", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 0, result: { timestamp: "0x6651a2c0" } },
          { jsonrpc: "2.0", id: 1, result: { timestamp: "0x6651a2cc" } },
        ]),
        { status: 200 },
      ),
    );

    const budget = createBudget(100);
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      [0x176f050, 0x176f051],
      budget,
    );

    expect(result.get(0x176f050)).toBe(0x6651a2c0);
    expect(result.get(0x176f051)).toBe(0x6651a2cc);
    expect(budget.count).toBe(1);
  });

  it("retries missing timestamp items with smaller batches", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 0, result: { timestamp: "0x6651a2c0" } },
            { jsonrpc: "2.0", id: 2, result: { timestamp: "0x6651a2e4" } },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ jsonrpc: "2.0", id: 0, result: { timestamp: "0x6651a2cc" } }]), { status: 200 }),
      );

    const budget = createBudget(100);
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      [0x176f050, 0x176f051, 0x176f052],
      budget,
    );

    expect(result.get(0x176f050)).toBe(0x6651a2c0);
    expect(result.get(0x176f051)).toBe(0x6651a2cc);
    expect(result.get(0x176f052)).toBe(0x6651a2e4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(budget.count).toBe(2);
  });

  it("uses local cache before fetching", async () => {
    const budget = createBudget(100);
    const local = new Map<number, number>([[0x176f050, 0x6651a2c0]]);

    const result = await resolveBlockTimestamps("https://eth-mainnet.g.alchemy.com/v2/key", [0x176f050], budget, {
      localCache: local,
    });

    expect(result.get(0x176f050)).toBe(0x6651a2c0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(budget.count).toBe(0);
  });

  it("reads from persistent timestamp cache before fetching", async () => {
    const db = makeDbForTimestampCache({
      cachedRows: [{ block_number: 0x176f050, timestamp: 0x6651a2c0 }],
    });

    const budget = createBudget(100);
    const result = await resolveBlockTimestamps("https://eth-mainnet.g.alchemy.com/v2/key", [0x176f050], budget, {
      persistentCache: { db, chainId: "ethereum" },
    });

    expect(result.get(0x176f050)).toBe(0x6651a2c0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(budget.count).toBe(0);
  });

  it("writes fetched timestamps into persistent cache", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ jsonrpc: "2.0", id: 0, result: { timestamp: "0x6651a2c0" } }]), { status: 200 }),
    );

    let batchWrites = 0;
    const db = makeDbForTimestampCache({
      cachedRows: [],
      onBatchWrite: (count) => {
        batchWrites += count;
      },
    });

    const budget = createBudget(100);
    const result = await resolveBlockTimestamps("https://eth-mainnet.g.alchemy.com/v2/key", [0x176f050], budget, {
      persistentCache: { db, chainId: "ethereum" },
    });

    expect(result.get(0x176f050)).toBe(0x6651a2c0);
    expect(batchWrites).toBeGreaterThan(0);
  });

  it("returns partial map when budget exhausted mid-batch", async () => {
    const blocks = Array.from({ length: 60 }, (_, idx) => 1000 + idx);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          Array.from({ length: 50 }, (_, idx) => ({
            jsonrpc: "2.0",
            id: idx,
            result: { timestamp: "0x" + (1700000000 + idx).toString(16) },
          })),
        ),
        { status: 200 },
      ),
    );

    const budget = createBudget(1);
    const result = await resolveBlockTimestamps("https://eth-mainnet.g.alchemy.com/v2/key", blocks, budget);

    expect(result.size).toBe(50);
  });

  it("chunks persistent cache reads to stay under SQL variable limits", async () => {
    const blocks = Array.from({ length: 220 }, (_, idx) => 2000 + idx);
    let cacheReadQueries = 0;
    let maxBindCount = 0;
    const db = makeDbForTimestampCache({
      cachedRows: blocks.map((block) => ({ block_number: block, timestamp: 1700000000 + block })),
      onCacheReadBindCount: (count) => {
        cacheReadQueries++;
        maxBindCount = Math.max(maxBindCount, count);
      },
    });

    const budget = createBudget(100);
    const result = await resolveBlockTimestamps("https://eth-mainnet.g.alchemy.com/v2/key", blocks, budget, {
      persistentCache: { db, chainId: "ethereum" },
    });

    expect(result.size).toBe(blocks.length);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheReadQueries).toBeGreaterThan(1);
    expect(maxBindCount).toBeLessThanOrEqual(100);
  });
});
