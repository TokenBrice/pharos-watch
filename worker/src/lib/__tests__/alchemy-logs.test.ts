import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildAlchemyUrl,
  getAlchemyBlockNumber,
  getAlchemyTransactionContextBatchMany,
  fetchAlchemyLogs,
  resolveBlockTimestamps,
} from "../alchemy-logs";
import { createBudget } from "../evm-logs";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

let fetchMock: ReturnType<typeof mockFetch>;

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

const timestampDatabases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of timestampDatabases.splice(0)) sqlite.close();
});

function makeDbForTimestampCache(
  opts: {
    cachedRows?: Array<{ block_number: number; timestamp: number; chain_id?: string; updated_at?: number }>;
    onCacheReadBindCount?: (count: number) => void;
  } = {},
): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  timestampDatabases.push(sqlite);
  sqlite.exec(`CREATE TABLE block_timestamp_cache (
    chain_id TEXT NOT NULL, block_number INTEGER NOT NULL, timestamp INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY (chain_id, block_number)
  )`);
  const insert = sqlite.prepare("INSERT INTO block_timestamp_cache VALUES (?, ?, ?, ?)");
  for (const row of opts.cachedRows ?? []) {
    insert.run(row.chain_id ?? "ethereum", row.block_number, row.timestamp, row.updated_at ?? Math.floor(Date.now() / 1000));
  }
  return createSqliteD1(sqlite, {
    onAll: (sql) => opts.onCacheReadBindCount?.((sql.match(/\?/g) ?? []).length),
  });
}

// --- buildAlchemyUrl ---

describe("buildAlchemyUrl", () => {
  it("builds correct URL for known chains", () => {
    expect(buildAlchemyUrl("ethereum", "test-key")).toBe("https://eth-mainnet.g.alchemy.com/v2/");
    expect(buildAlchemyUrl("base", "test-key")).toBe("https://base-mainnet.g.alchemy.com/v2/");
    expect(buildAlchemyUrl("avalanche", "test-key")).toBe("https://avax-mainnet.g.alchemy.com/v2/");
  });

  it("returns null for unknown chains", () => {
    expect(buildAlchemyUrl("tron", "test-key")).toBeNull();
    expect(buildAlchemyUrl("solana", "test-key")).toBeNull();
  });
});

// --- getAlchemyBlockNumber ---

describe("getAlchemyBlockNumber", () => {
  beforeEach(() => {
    fetchMock = mockFetch([], { requireMatch: true });
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

  it("attaches the Alchemy bearer token without putting it in the URL", async () => {
    fetchMock = mockFetch([
      {
        match: "https://eth-mainnet.g.alchemy.com/v2/",
        matchHeaders: { Authorization: "Bearer test-key" },
        body: { jsonrpc: "2.0", id: 1, result: "0x176f12d" },
      },
    ], { requireMatch: true, strictUrl: true });

    const alchemyUrl = buildAlchemyUrl("ethereum", "test-key");
    expect(alchemyUrl).toBe("https://eth-mainnet.g.alchemy.com/v2/");
    const result = await getAlchemyBlockNumber(alchemyUrl!, createBudget(100));

    expect(result).toBe(0x176f12d);
    expect(fetchMock.getHistory()[0]).toMatchObject({
      url: "https://eth-mainnet.g.alchemy.com/v2/",
      headers: { authorization: "Bearer test-key" },
    });
  });

  it("returns null on 5xx HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));

    const budget = createBudget(100);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);

    expect(result).toBeNull();
    expect(budget.count).toBe(1);
  });

  it("emits structured JSON-RPC error metadata", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "request limit exceeded" } }),
        { status: 429 },
      ),
    );

    const budget = createBudget(100);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);

    expect(result).toBeNull();
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      scope: "lib",
      level: "warn",
      event: "alchemy_json_rpc_error",
      provider: "alchemy",
      status: 429,
      metadata: {
        method: "eth_blockNumber",
        rpcErrorCode: -32005,
        rpcErrorMessage: "request limit exceeded",
      },
    });
    warnSpy.mockRestore();
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
    fetchMock = mockFetch([], { requireMatch: true });
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
    fetchMock = mockFetch([], { requireMatch: true });
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
    fetchMock = mockFetch([], { requireMatch: true });
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
    fetchMock = mockFetch([
      { match: () => true, body: { jsonrpc: "2.0", id: 1, result: [] } },
    ]);

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

    const body = JSON.parse(fetchMock.getHistory()[0]?.body ?? "");
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
    fetchMock = mockFetch([], { requireMatch: true });
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

  it("excludes other chains and expired persistent timestamps", async () => {
    const db = makeDbForTimestampCache({
      cachedRows: [
        { block_number: 100, timestamp: 1700000100 },
        { block_number: 100, timestamp: 999, chain_id: "base" },
        { block_number: 101, timestamp: 1700000101, updated_at: 1 },
        { block_number: 102, timestamp: 1700000102 },
      ],
    });
    const result = await resolveBlockTimestamps("https://eth-mainnet.g.alchemy.com/v2/key", [100, 101], createBudget(0), {
      persistentCache: { db, chainId: "ethereum" },
    });
    expect([...result]).toEqual([[100, 1700000100]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes fetched timestamps into persistent cache", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ jsonrpc: "2.0", id: 0, result: { timestamp: "0x6651a2c0" } }]), { status: 200 }),
    );

    const db = makeDbForTimestampCache();

    const budget = createBudget(100);
    const result = await resolveBlockTimestamps("https://eth-mainnet.g.alchemy.com/v2/key", [0x176f050], budget, {
      persistentCache: { db, chainId: "ethereum" },
    });

    expect(result.get(0x176f050)).toBe(0x6651a2c0);
    const cached = await resolveBlockTimestamps("https://eth-mainnet.g.alchemy.com/v2/key", [0x176f050], createBudget(0), {
      persistentCache: { db, chainId: "ethereum" },
    });
    expect([...cached]).toEqual([[0x176f050, 0x6651a2c0]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

    expect([...result]).toEqual(blocks.map((block) => [block, 1700000000 + block]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheReadQueries).toBeGreaterThan(1);
    expect(maxBindCount).toBeLessThanOrEqual(100);
  });
});
