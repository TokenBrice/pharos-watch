import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  buildAlchemyUrl,
  getAlchemyBlockNumber,
  getAlchemyTransactionContextBatchMany,
  fetchAlchemyLogs,
  resolveBlockTimestamps,
  blockHashesForLogs,
} from "../alchemy-logs";
import { createBudget } from "../evm-logs";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { fetchEvmBlockNumber, fetchEvmRpcBatch, requestJsonRpcAtUrl, usableCcipRpcEndpoints } from "../evm-rpc";
import { registerRpcAuth, type ChainRpcConfig } from "../chain-registry";
import * as rpcCredits from "../rpc-provider-budget";
import * as evmRpc from "../evm-rpc";
import { withRpcRequestObserver } from "../rpc-request-observer";

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

const timestampFixtures = createLatestSchemaFixtureTracker();
afterEach(() => timestampFixtures.closeAll());

function makeDbForTimestampCache(
  opts: {
    cachedRows?: Array<{ block_number: number; timestamp: number; chain_id?: string; updated_at?: number; block_hash?: string | null }>;
    onCacheReadBindCount?: (count: number) => void;
  } = {},
): D1Database {
  const { sqlite } = timestampFixtures.open();
  const insert = sqlite.prepare(`INSERT INTO block_timestamp_cache
    (chain_id, block_number, timestamp, updated_at, block_hash) VALUES (?, ?, ?, ?, ?)`);
  for (const row of opts.cachedRows ?? []) {
    insert.run(row.chain_id ?? "ethereum", row.block_number, row.timestamp, row.updated_at ?? Math.floor(Date.now() / 1000), row.block_hash ?? null);
  }
  return createSqliteD1(sqlite, {
    onAll: (sql) => opts.onCacheReadBindCount?.((sql.match(/\?/g) ?? []).length),
  });
}

// --- buildAlchemyUrl ---

describe("buildAlchemyUrl", () => {

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

describe("single-URL JSON-RPC transport contracts", () => {
  beforeEach(() => { fetchMock = mockFetch([], { requireMatch: true }); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["generic", "alchemy"] as const)("retains authenticated payloads and rejects wrong identities for %s reads", async consumer => {
    const url = buildAlchemyUrl("ethereum", "contract-key")!;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer contract-key");
      expect(JSON.parse(String(init?.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
      return Response.json({ id: 2, result: "0x10" });
    });
    const read = () => consumer === "generic"
      ? fetchEvmBlockNumber("ethereum", { extraRpcUrls: [url], maxRetries: 0 })
      : getAlchemyBlockNumber(url, createBudget(1));
    expect(await read()).toBeNull();
    network.mockResolvedValueOnce(Response.json({ id: 1, result: "0x10" }));
    expect(await read()).toBe(16);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("distinguishes HTTP/RPC, text parse and unstarted control outcomes without hiding provider policy", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const payload = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };
    network.mockResolvedValueOnce(Response.json({ id: 1, error: { code: -32000, message: "busy" } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ id: 1, error: { code: -32000, message: "busy" } }))
      .mockResolvedValueOnce(new Response("not JSON", { status: 503 }))
      .mockResolvedValueOnce(new Response("not JSON", { status: 200 }));
    expect(await requestJsonRpcAtUrl("https://rpc.invalid", payload, {})).toMatchObject({ status: "http-error", response: { status: 403 } });
    expect(await requestJsonRpcAtUrl("https://rpc.invalid", payload, {})).toMatchObject({ status: "rpc-error" });
    // A non-2xx status survives a non-JSON body; parse errors are for OK bodies.
    expect(await requestJsonRpcAtUrl("https://rpc.invalid", payload, { responseMode: "text" })).toMatchObject({ status: "http-error", response: { status: 503 } });
    expect(await requestJsonRpcAtUrl("https://rpc.invalid", payload, {})).toMatchObject({ status: "parse-error", response: { status: 200 } });
    expect(await requestJsonRpcAtUrl("https://rpc.invalid", payload, { beforeRequest: () => false })).toMatchObject({ status: "control-error" });
    expect(network).toHaveBeenCalledTimes(4);
  });

  it.each(["single", "batch", "noBatch"] as const)("preserves ordered admission/meter/network/demotion traces for %s", async mode => {
    vi.useFakeTimers();
    const primary = "https://trace.dwellir.invalid", fallback = "https://trace-public.invalid";
    registerRpcAuth("dwellir", primary, { "X-Api-Key": "trace-key" });
    const trace: string[] = [];
    const chainRpcs = new Map<string, ChainRpcConfig>([["trace", {
      chainId: "trace", chainName: "Trace", type: "evm", explorerUrl: "https://explorer.invalid",
      endpoints: [
        { url: primary, operator: "dwellir", keyed: true, position: "supplemental", stateHistory: "archive", logsHistory: "full", noBatch: mode === "noBatch" },
        { url: fallback, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" },
      ],
      onRpcRequest: ({ rpcCalls }) => trace.push(`admitted:${rpcCalls}`),
    }]]);
    vi.spyOn(rpcCredits, "recordDwellirCredits").mockImplementation(count => { trace.push(`meter:${count}`); });
    let failure: "none" | "http" | "network" = "none", denyRetry = false, attempts = 0;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const payload = JSON.parse(String(init?.body));
      trace.push(`network:${url === primary ? "primary" : "fallback"}:${Array.isArray(payload) ? "batch" : payload.id}`);
      if (url === primary) expect(new Headers(init?.headers).get("X-Api-Key")).toBe("trace-key");
      if (failure === "network" && url === primary) throw new TypeError("network failure");
      if (failure === "http" && url === primary) return Response.json({ error: "busy" }, { status: 503 });
      const row = (request: { id: number }) => ({ id: request.id, result: "0x10" });
      return Response.json(Array.isArray(payload) ? payload.map(row) : row(payload));
    });
    const invoke = () => {
      const options = { chainRpcs, maxRetries: 1, beforeRequest: (url: string) => {
        trace.push(`before:${url === primary ? "primary" : "fallback"}`);
        trace.push(`demoted:${!usableCcipRpcEndpoints("trace", chainRpcs, { kind: "logs", fromBlock: 1, toBlock: 1 }).some(row => row.url === primary)}`);
        return !denyRetry || attempts++ === 0;
      } };
      return mode === "single" ? fetchEvmBlockNumber("trace", options)
        : fetchEvmRpcBatch("trace", [{ method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] }], options);
    };
    denyRetry = true;
    attempts = 1;
    expect(await invoke()).toBeNull();
    expect(trace).toEqual(["before:primary", "demoted:false"]);
    expect(network).not.toHaveBeenCalled();
    trace.length = 0;
    denyRetry = false;
    attempts = 0;
    expect(await invoke()).toEqual(mode === "single" ? 16 : ["0x10", "0x10"]);
    const admitted = (id: number) => ["before:primary", "demoted:false", `meter:${mode === "batch" ? 2 : 1}`,
      `admitted:${mode === "batch" ? 2 : 1}`, `network:primary:${mode === "batch" ? "batch" : id}`];
    expect(trace).toEqual(mode === "noBatch" ? [...admitted(1), ...admitted(2)] : admitted(1));
    trace.length = 0;
    failure = "http";
    expect(await invoke()).toEqual(mode === "single" ? 16 : ["0x10", "0x10"]);
    expect(trace).toEqual([...admitted(1), "before:fallback", "demoted:false",
      `admitted:${mode === "single" ? 1 : 2}`, `network:fallback:${mode === "single" ? 1 : "batch"}`]);
    trace.length = 0;
    failure = "network";
    denyRetry = true;
    const pending = invoke();
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(trace).toEqual([...admitted(1), "before:primary", "demoted:false"]);
    trace.length = 0;
    denyRetry = false;
    expect(await invoke()).toEqual(mode === "single" ? 16 : ["0x10", "0x10"]);
    expect(trace).toEqual(["before:fallback", "demoted:true", `admitted:${mode === "single" ? 1 : 2}`, `network:fallback:${mode === "single" ? 1 : "batch"}`]);
    expect(network).toHaveBeenCalledTimes(mode === "noBatch" ? 6 : 5);
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

  it("returns named unavailable contexts when circuit admission denies a batch", async () => {
    const onOutcome = vi.fn();
    const result = await withRpcRequestObserver({ beforeRequest: () => false, onOutcome }, () =>
      getAlchemyTransactionContextBatchMany("https://rpc.invalid", ["0xaaa"], createBudget(10)));
    expect(result.get("0xaaa")).toEqual({ tx: null, receipt: null, unavailableReason: "rpc-request-not-started" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("still propagates caller cancellation during transaction-context admission", async () => {
    const controller = new AbortController();
    const run = withRpcRequestObserver({
      beforeRequest: () => { controller.abort(new Error("caller stopped")); return false; }, onOutcome: vi.fn(),
    }, () => getAlchemyTransactionContextBatchMany("https://rpc.invalid", ["0xaaa"], createBudget(10), controller.signal));
    await expect(run).rejects.toThrow("caller stopped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unavailable contexts for a transport error carrying an exception", async () => {
    const request = vi.spyOn(evmRpc, "requestJsonRpcAtUrl").mockResolvedValueOnce({
      status: "transport-error", error: new Error("socket closed"),
    });
    try {
      const result = await getAlchemyTransactionContextBatchMany("https://rpc.invalid", ["0xaaa"], createBudget(10));
      expect(result.get("0xaaa")).toEqual({ tx: null, receipt: null });
    } finally {
      request.mockRestore();
    }
  });

  it("keeps member-retry transport errors unavailable instead of aborting the batch", async () => {
    const originalRequest = evmRpc.requestJsonRpcAtUrl;
    const request = vi.spyOn(evmRpc, "requestJsonRpcAtUrl")
      .mockImplementationOnce(originalRequest)
      .mockResolvedValueOnce({ status: "transport-error", error: new Error("socket closed") });
    const receipt = { transactionHash: "0xaaa", to: null, logs: [] };
    fetchMock.mockResolvedValueOnce(Response.json([
      { id: 0, error: { code: -32000, message: "batch not executed" } }, { id: 1, result: receipt },
    ]));
    try {
      const result = await getAlchemyTransactionContextBatchMany("https://rpc.invalid", ["0xaaa"], createBudget(10));
      expect(result.get("0xaaa")).toEqual({ tx: null, receipt });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      request.mockRestore();
    }
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

  it("rejects duplicate context identities while retaining uniquely identified peers", async () => {
    const tx = { hash: "0xaaa", to: null, input: "0x" };
    const receipt = { transactionHash: "0xaaa", to: null, logs: [] };
    fetchMock.mockResolvedValueOnce(Response.json([
      { id: 0, result: tx }, { id: 0, result: tx }, { id: 1, result: receipt },
    ]));
    const result = await getAlchemyTransactionContextBatchMany("https://rpc.invalid", ["0xaaa"], createBudget(1));
    expect(result.get("0xaaa")).toEqual({ tx: null, receipt });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("quarantines malformed transaction-context peers without dropping valid peers", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 0, result: { hash: "0xaaa", to: "0xrouter", input: 42 } },
          { jsonrpc: "2.0", id: 1, result: { transactionHash: "0xaaa", to: "0xrouter", logs: {} } },
          { jsonrpc: "2.0", id: 2, result: { hash: "0xbbb", to: "0xrouter", input: "0x87654321" } },
          { jsonrpc: "2.0", id: 3, result: { transactionHash: "0xbbb", to: "0xrouter", logs: [] } },
        ]),
        { status: 200 },
      ),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await getAlchemyTransactionContextBatchMany(
        "https://eth-mainnet.g.alchemy.com/v2/key",
        ["0xaaa", "0xbbb"],
        createBudget(100),
      );

      expect(result.get("0xaaa")).toEqual({ tx: null, receipt: null });
      expect(result.get("0xbbb")?.tx?.hash).toBe("0xbbb");
      expect(result.get("0xbbb")?.receipt?.transactionHash).toBe("0xbbb");
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
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

  const hash = `0x${"a".repeat(64)}`;
  const header = (number: number, timestamp: string) => ({
    number: `0x${number.toString(16)}`, timestamp, hash,
  });

  it.each([
    ["duplicate", [{ id: 0, result: { number: "0x64", timestamp: "0xc8", hash } }]],
    ["duplicate without hash", [{ id: 0, result: { number: "0x64", timestamp: "0xc8" } }]],
    ["out-of-range", [{ id: 1, result: { number: "0x64", timestamp: "0xc8", hash } }]],
  ])("never caches ambiguous %s timestamp evidence", async (_label, extra) => {
    const db = makeDbForTimestampCache();
    const localCache = new Map<string, number>();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 0, result: header(100, "0x64") }, ...extra,
    ])));
    const options = { localCache, blockHashes: new Map([[100, hash]]),
      persistentCache: { db, chainId: "ethereum" } };
    const result = await resolveBlockTimestamps("https://rpc.invalid", [100], createBudget(1), options);
    // Out-of-range peers are ignored; duplicate IDs invalidate both candidates.
    const expected = _label === "out-of-range" ? [[100, 100]] : [];
    expect([...result]).toEqual(expected);
    expect([...await resolveBlockTimestamps("https://rpc.invalid", [100], createBudget(0), {
      ...options, localCache: new Map(),
    })]).toEqual(expected);
    expect([...localCache.values()]).toEqual(_label === "out-of-range" ? [100] : []);
  });

  it.each([
    { number: "0x65", timestamp: "0x64", hash },
    { number: "0x64", timestamp: "0x64" },
    { number: "0x64", timestamp: "0x0", hash },
    { number: "0x64", timestamp: "0x20000000000000", hash },
    { number: "0x64", timestamp: "0x64", hash: "0x1234" },
  ])("retries malformed complete headers without caching their timestamp: %j", async result => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ id: 0, result }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 0, result: header(100, "0xc8") }])));
    const db = makeDbForTimestampCache();
    const options = { blockHashes: new Map([[100, hash]]), persistentCache: { db, chainId: "ethereum" } };
    expect([...await resolveBlockTimestamps("https://rpc.invalid", [100], createBudget(2), options)])
      .toEqual([[100, 200]]);
    expect([...await resolveBlockTimestamps("https://rpc.invalid", [100], createBudget(0), options)])
      .toEqual([[100, 200]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries duplicate members while retaining unique complete peers", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 0, result: header(100, "0x64") },
      { id: 0, result: { number: "0x64", timestamp: "0xc8" } },
      { id: 1, result: header(101, "0x65") },
    ]))).mockResolvedValueOnce(new Response(JSON.stringify([{ id: 0, result: header(100, "0x12c") }])));
    expect([...await resolveBlockTimestamps("https://rpc.invalid", [100, 101], createBudget(2))])
      .toEqual([[101, 101], [100, 300]]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))[0].params).toEqual(["0x64", false]);
  });

  it("batch-fetches timestamps for multiple blocks", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 0, result: header(0x176f050, "0x6651a2c0") },
          { jsonrpc: "2.0", id: 1, result: header(0x176f051, "0x6651a2cc") },
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
            { jsonrpc: "2.0", id: 0, result: header(0x176f050, "0x6651a2c0") },
            { jsonrpc: "2.0", id: 2, result: header(0x176f052, "0x6651a2e4") },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ jsonrpc: "2.0", id: 0, result: header(0x176f051, "0x6651a2cc") }]), { status: 200 }),
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
    const local = new Map<string, number>([[`${0x176f050}:unverified`, 0x6651a2c0]]);

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
      new Response(JSON.stringify([{ jsonrpc: "2.0", id: 0, result: header(0x176f050, "0x6651a2c0") }]), { status: 200 }),
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

  it("refetches replacement-block timestamps and never accepts orphan or unknown hashes", async () => {
    const orphan = "0x" + "a".repeat(64);
    const replacement = "0x" + "b".repeat(64);
    const db = makeDbForTimestampCache({
      cachedRows: [{ block_number: 100, timestamp: 1, block_hash: orphan }, { block_number: 101, timestamp: 2 }],
    });
    const local = new Map<string, number>([[`100:${orphan}`, 1]]);
    const hashes = new Map([[100, replacement], [101, replacement]]);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { jsonrpc: "2.0", id: 0, result: { ...header(100, "0x64"), hash: replacement } },
      { jsonrpc: "2.0", id: 1, result: { ...header(101, "0x65"), hash: replacement } },
    ])));
    const options = { localCache: local, blockHashes: hashes, persistentCache: { db, chainId: "ethereum" } };
    expect([...await resolveBlockTimestamps("https://rpc.invalid", [100, 101], createBudget(1), options)])
      .toEqual([[100, 100], [101, 101]]);
    expect([...await resolveBlockTimestamps("https://rpc.invalid", [100, 101], createBudget(0), {
      ...options, localCache: new Map(),
    })]).toEqual([[100, 100], [101, 101]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("withholds timestamps when returned blocks disagree with the scanned hash or logs mix forks", async () => {
    const hash = "0x" + "a".repeat(64);
    const replacement = "0x" + "b".repeat(64);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([
      { jsonrpc: "2.0", id: 0, result: { ...header(100, "0x64"), hash: replacement } },
    ])));
    expect(await resolveBlockTimestamps("https://rpc.invalid", [100], createBudget(1), {
      blockHashes: new Map([[100, hash]]),
    })).toEqual(new Map());
    const hashes = blockHashesForLogs([
      { blockNumber: "0x64", blockHash: hash }, { blockNumber: "0x64", blockHash: replacement },
    ]);
    expect(await resolveBlockTimestamps("https://rpc.invalid", [100], createBudget(1), { blockHashes: hashes })).toEqual(new Map());
  });

  it("returns partial map when budget exhausted mid-batch", async () => {
    const blocks = Array.from({ length: 60 }, (_, idx) => 1000 + idx);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          Array.from({ length: 50 }, (_, idx) => ({
            jsonrpc: "2.0",
            id: idx,
            result: header(1000 + idx, "0x" + (1700000000 + idx).toString(16)),
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
