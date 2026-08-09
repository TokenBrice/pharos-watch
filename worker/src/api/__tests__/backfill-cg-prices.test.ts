import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { handleBackfillCgPricesTrusted } from "../backfill-cg-prices";

stubCryptoForAuth();

vi.mock("../../lib/fetch-retry", () => {
  const fetchWithRetry = vi.fn(async () => (
    new Response(
      JSON.stringify({
        prices: [[1_700_000_000_000, 1.001]],
        market_caps: [[1_700_000_000_000, 123_456_789]],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  ));
  return {
    fetchWithRetry,
    fetchJsonWithRetry: async (..._args: unknown[]) => {
      const response = await fetchWithRetry();
      return { response, body: await response.json() };
    },
  };
});

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

  it("returns 404 for unknown stablecoin", async () => {
    const res = await handleBackfillCgPricesTrusted({ db: makeDb(), url: makeApiUrl("/api/backfill-cg-prices?stablecoin=missing") });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Stablecoin not found" });
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillCgPricesTrusted({ db: makeDb(), url: makeApiUrl("/api/backfill-cg-prices?batch=999999&batchSize=100") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "No coins in this batch" });
  });

  it("fills NULL prices for existing supply rows", async () => {
    const snapshotDate = Math.floor(1_700_000_000 / 86400) * 86400;
    const res = await handleBackfillCgPricesTrusted({ db: makeDb([{ snapshot_date: snapshotDate, price: null, circulating_usd: 100_000_000 }]), url: makeApiUrl("/api/backfill-cg-prices?stablecoin=usdt-tether") });

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

  it("accepts PSI-only shadow assets for price backfills", async () => {
    const snapshotDate = Math.floor(1_700_000_000 / 86400) * 86400;
    const res = await handleBackfillCgPricesTrusted({ db: makeDb([{ snapshot_date: snapshotDate, price: null, circulating_usd: 15_000_000_000 }]), url: makeApiUrl("/api/backfill-cg-prices?stablecoin=ust-terra") });

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
