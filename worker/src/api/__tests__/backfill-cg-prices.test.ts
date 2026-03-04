import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleBackfillCgPrices } from "../backfill-cg-prices";

vi.stubGlobal("crypto", {
  subtle: {
    digest: async (_algo: string, data: ArrayBuffer) => data,
    timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => {
      const av = new Uint8Array(a);
      const bv = new Uint8Array(b);
      if (av.length !== bv.length) return false;
      return av.every((byte, i) => byte === bv[i]);
    },
  },
});

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async () => (
    new Response(
      JSON.stringify({
        prices: [[1_700_000_000_000, 1.001]],
        market_caps: [[1_700_000_000_000, 123_456_789]],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  )),
}));

function makeDb(existingRows: Array<{ snapshot_date: number; price: number | null; circulating_usd: number }> = []): D1Database {
  const stmt = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      all: async <T>() => {
        if (sql.includes("SELECT snapshot_date, price, circulating_usd FROM supply_history")) {
          return { results: existingRows as T[], success: true, meta: {} };
        }
        return { results: [] as T[], success: true, meta: {} };
      },
      first: async <T>() => null as T | null,
      run: async () => ({ success: true, meta: { changes: 1 } }),
    }),
    all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
    first: async <T>() => null as T | null,
    run: async () => ({ success: true, meta: { changes: 1 } }),
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: D1PreparedStatement[]) => (
      stmts.map(() => ({ success: true, meta: { changes: 1 } }))
    ),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("handleBackfillCgPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires admin auth", async () => {
    const res = await handleBackfillCgPrices(
      makeDb(),
      new URL("https://x/api/backfill-cg-prices"),
      "secret",
      new Request("https://x/api/backfill-cg-prices"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown stablecoin", async () => {
    const res = await handleBackfillCgPrices(
      makeDb(),
      new URL("https://x/api/backfill-cg-prices?stablecoin=missing"),
      "secret",
      new Request("https://x/api/backfill-cg-prices?stablecoin=missing", {
        headers: { "X-Admin-Key": "secret" },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Stablecoin not found" });
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillCgPrices(
      makeDb(),
      new URL("https://x/api/backfill-cg-prices?batch=999999&batchSize=100"),
      "secret",
      new Request("https://x/api/backfill-cg-prices?batch=999999&batchSize=100", {
        headers: { "X-Admin-Key": "secret" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "No coins in this batch" });
  });

  it("fills NULL prices for existing supply rows", async () => {
    const snapshotDate = Math.floor(1_700_000_000 / 86400) * 86400;
    const res = await handleBackfillCgPrices(
      makeDb([{ snapshot_date: snapshotDate, price: null, circulating_usd: 100_000_000 }]),
      new URL("https://x/api/backfill-cg-prices?stablecoin=1"),
      "secret",
      new Request("https://x/api/backfill-cg-prices?stablecoin=1", {
        headers: { "X-Admin-Key": "secret" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coinsProcessed: number;
      totalPricesFilled: number;
      totalRowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.totalPricesFilled).toBe(1);
    expect(body.totalRowsInserted).toBe(0);
    expect(body.errors).toBeUndefined();
  });
});
