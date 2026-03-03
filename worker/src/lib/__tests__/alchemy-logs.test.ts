import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAlchemyUrl,
  getAlchemyBlockNumber,
  fetchAlchemyLogs,
  resolveBlockTimestamps,
} from "../alchemy-logs";
import { createBudget } from "../evm-logs";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// --- buildAlchemyUrl ---

describe("buildAlchemyUrl", () => {
  it("builds correct URL for known chains", () => {
    expect(buildAlchemyUrl("ethereum", "test-key")).toBe(
      "https://eth-mainnet.g.alchemy.com/v2/test-key"
    );
    expect(buildAlchemyUrl("base", "test-key")).toBe(
      "https://base-mainnet.g.alchemy.com/v2/test-key"
    );
    expect(buildAlchemyUrl("avalanche", "test-key")).toBe(
      "https://avax-mainnet.g.alchemy.com/v2/test-key"
    );
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
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x176f12d" }),
      { status: 200 },
    ));
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

  it("parses error message from 400 JSON-RPC response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "block range too large" } }),
      { status: 400 },
    ));
    const budget = createBudget(100);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);
    expect(result).toBeNull();
  });

  it("returns null when budget exhausted", async () => {
    const budget = createBudget(0);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- fetchAlchemyLogs ---

describe("fetchAlchemyLogs", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("returns parsed log entries on success", async () => {
    const mockLogs = [
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        topics: ["0xddf252ad...", "0x0000..."],
        data: "0x00000000000000000000000000000000000000000000000000000002540be400",
        blockNumber: "0x176f050",
        transactionHash: "0xabc123",
        transactionIndex: "0x0",
        blockHash: "0xdef456",
        logIndex: "0x0",
        removed: false,
      },
    ];
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: mockLogs }),
      { status: 200 },
    ));
    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      [{ index: 0, value: "0xddf252ad..." }],
      0x176f000, 0x176f100, budget,
    );
    expect(result).toHaveLength(1);
    expect(result![0].transactionHash).toBe("0xabc123");
    expect(budget.count).toBe(1);
  });

  it("returns empty array when no logs found", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }),
      { status: 200 },
    ));
    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract", [{ index: 0, value: "0xtopic" }],
      100, 200, budget,
    );
    expect(result).toEqual([]);
  });

  it("returns null on JSON-RPC error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad range" } }),
      { status: 400 },
    ));
    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract", [{ index: 0, value: "0xtopic" }],
      100, 200, budget,
    );
    expect(result).toBeNull();
  });

  it("returns null when budget exhausted", async () => {
    const budget = createBudget(0);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract", [{ index: 0, value: "0xtopic" }],
      100, 200, budget,
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- resolveBlockTimestamps ---

describe("resolveBlockTimestamps", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("batch-fetches timestamps for multiple blocks", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify([
        { jsonrpc: "2.0", id: 0, result: { timestamp: "0x6651a2c0" } },
        { jsonrpc: "2.0", id: 1, result: { timestamp: "0x6651a2cc" } },
      ]),
      { status: 200 },
    ));
    const budget = createBudget(100);
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      [0x176f050, 0x176f051], budget,
    );
    expect(result.get(0x176f050)).toBe(0x6651a2c0);
    expect(result.get(0x176f051)).toBe(0x6651a2cc);
    expect(budget.count).toBe(1);
  });

  it("returns empty map for empty input", async () => {
    const budget = createBudget(100);
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      [], budget,
    );
    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splits into batches of 50", async () => {
    const blocks = Array.from({ length: 60 }, (_, i) => 1000 + i);
    const makeBatchResponse = (count: number, startIdx: number) =>
      Array.from({ length: count }, (_, i) => ({
        jsonrpc: "2.0", id: startIdx + i,
        result: { timestamp: "0x" + (1700000000 + startIdx + i).toString(16) },
      }));

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(makeBatchResponse(50, 0)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(makeBatchResponse(10, 50)), { status: 200 }));

    const budget = createBudget(100);
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      blocks, budget,
    );
    expect(result.size).toBe(60);
    expect(budget.count).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns partial map when budget exhausted mid-batch", async () => {
    const blocks = Array.from({ length: 60 }, (_, i) => 1000 + i);
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify(Array.from({ length: 50 }, (_, i) => ({
        jsonrpc: "2.0", id: i,
        result: { timestamp: "0x" + (1700000000 + i).toString(16) },
      }))),
      { status: 200 },
    ));

    const budget = createBudget(1);
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      blocks, budget,
    );
    expect(result.size).toBe(50);
  });
});
