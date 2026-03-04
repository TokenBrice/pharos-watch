import { describe, expect, it, vi, beforeEach } from "vitest";

vi.stubGlobal("crypto", {
  subtle: {
    digest: async (_algo: string, data: ArrayBuffer) => data,
    timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => {
      const av = new Uint8Array(a);
      const bv = new Uint8Array(b);
      if (av.length !== bv.length) return false;
      return av.every((byte, idx) => byte === bv[idx]);
    },
  },
});

vi.mock("../../lib/alchemy-logs", () => ({
  buildAlchemyUrl: vi.fn(() => "https://eth-mainnet.g.alchemy.com/v2/test-key"),
  getAlchemyBlockNumber: vi.fn(async () => 22_000_000),
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, calls: 1, maxDepth: 0 })),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

import { handleBackfillMintBurn } from "../backfill-mint-burn";

function makeDb(): D1Database {
  const stmt = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
      first: async <T>() => {
        if (sql.includes("SELECT last_block FROM mint_burn_sync_state")) {
          return { last_block: 21_899_999 } as T;
        }
        return null as T | null;
      },
      run: async () => ({ success: true, meta: { changes: 1 } }),
    }),
    all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
    first: async <T>() => null as T | null,
    run: async () => ({ success: true, meta: { changes: 1 } }),
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("handleBackfillMintBurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires admin auth", async () => {
    const response = await handleBackfillMintBurn(
      makeDb(),
      new URL("https://x/api/backfill-mint-burn?configKey=ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
      "secret",
      new Request("https://x/api/backfill-mint-burn"),
      "alchemy-key",
    );

    expect(response.status).toBe(401);
  });

  it("validates configKey", async () => {
    const response = await handleBackfillMintBurn(
      makeDb(),
      new URL("https://x/api/backfill-mint-burn"),
      "secret",
      new Request("https://x/api/backfill-mint-burn", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": "secret",
        },
        body: JSON.stringify({}),
      }),
      "alchemy-key",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("configKey");
  });

  it("returns done when requested range is empty", async () => {
    const request = new Request("https://x/api/backfill-mint-burn", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": "secret",
      },
      body: JSON.stringify({
        configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        fromBlock: 100,
        toBlock: 90,
      }),
    });

    const response = await handleBackfillMintBurn(
      makeDb(),
      new URL("https://x/api/backfill-mint-burn"),
      "secret",
      request,
      "alchemy-key",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      done: boolean;
      chunksProcessed: number;
      effectiveBurns: number;
      bridgeBurns: number;
      reviewBurns: number;
    };
    expect(body.done).toBe(true);
    expect(body.chunksProcessed).toBe(0);
    expect(body.effectiveBurns).toBe(0);
    expect(body.bridgeBurns).toBe(0);
    expect(body.reviewBurns).toBe(0);
  });

  it("returns nextFromBlock when maxChunks stops before toBlock", async () => {
    const request = new Request("https://x/api/backfill-mint-burn", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": "secret",
      },
      body: JSON.stringify({
        configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        fromBlock: 100,
        toBlock: 280,
        chunkSize: 50,
        maxChunks: 2,
      }),
    });

    const response = await handleBackfillMintBurn(
      makeDb(),
      new URL("https://x/api/backfill-mint-burn"),
      "secret",
      request,
      "alchemy-key",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      done: boolean;
      nextFromBlock: number | null;
      chunksProcessed: number;
    };

    expect(body.done).toBe(false);
    expect(body.chunksProcessed).toBe(2);
    expect(body.nextFromBlock).toBe(200);
  });
});
