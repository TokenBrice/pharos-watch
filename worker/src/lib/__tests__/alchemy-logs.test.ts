import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAlchemyUrl, getAlchemyBlockNumber } from "../alchemy-logs";
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
