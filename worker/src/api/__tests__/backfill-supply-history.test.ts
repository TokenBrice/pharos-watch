import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { handleBackfillSupplyHistory } from "../backfill-supply-history";

stubCryptoForAuth();

function makeDb(): D1Database {
  const stmt = (_sql: string) => ({
    bind: (..._args: unknown[]) => ({
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
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

describe("handleBackfillSupplyHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requires admin auth", async () => {
    const res = await handleBackfillSupplyHistory(
      makeDb(),
      makeApiUrl("/api/backfill-supply-history"),
      undefined,
      makeApiRequest("/api/backfill-supply-history"),
    );

    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown stablecoin", async () => {
    const res = await handleBackfillSupplyHistory(
      makeDb(),
      makeApiUrl("/api/backfill-supply-history?stablecoin=not-a-real-id"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=not-a-real-id", { adminKey: "secret" }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Stablecoin not found" });
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillSupplyHistory(
      makeDb(),
      makeApiUrl("/api/backfill-supply-history?batch=999999&batchSize=100"),
      true,
      makeApiRequest("/api/backfill-supply-history?batch=999999&batchSize=100", { adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "No coins in this batch" });
  });

  it("inserts rows for a valid USD stablecoin detail payload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          price: 1,
          tokens: [
            {
              date: 1_700_000_000,
              circulating: { peggedUSD: 125_000_000 },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await handleBackfillSupplyHistory(
      makeDb(),
      makeApiUrl("/api/backfill-supply-history?stablecoin=usdt-tether"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=usdt-tether", { adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(1);
    expect(body.errors).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/stablecoin/1"),
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": expect.any(String) }),
      }),
    );
  });
});
