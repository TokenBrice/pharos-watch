import { describe, expect, it, vi } from "vitest";
import { handleBackfillMintBurnPrices } from "../backfill-mint-burn-prices";

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

type QueryRecord = {
  kind: "all" | "first" | "run";
  sql: string;
  args: unknown[];
};

function makeBackfillDb() {
  const queries: QueryRecord[] = [];

  const invokeAll = async <T>(sql: string, args: unknown[]) => {
    queries.push({ kind: "all", sql, args });

    if (sql.includes("FROM price_cache")) {
      return {
        success: true,
        meta: {},
        results: [{ asset_id: "1", price: 1.002, updated_at: 1_710_000_000 }] as T[],
      };
    }
    if (sql.includes("SELECT DISTINCT stablecoin_id FROM mint_burn_events")) {
      return {
        success: true,
        meta: {},
        results: [{ stablecoin_id: "1" }] as T[],
      };
    }
    return { success: true, meta: {}, results: [] as T[] };
  };

  const invokeFirst = async <T>(sql: string, args: unknown[]) => {
    queries.push({ kind: "first", sql, args });
    return null as T | null;
  };

  const invokeRun = async (sql: string, args: unknown[]) => {
    queries.push({ kind: "run", sql, args });

    if (sql.includes("UPDATE mint_burn_events")) {
      return { success: true, meta: { changes: 2 } };
    }
    return { success: true, meta: { changes: 0 } };
  };

  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      all: async <T>() => invokeAll<T>(sql, args),
      first: async <T>() => invokeFirst<T>(sql, args),
      run: async () => invokeRun(sql, args),
    }),
    all: async <T>() => invokeAll<T>(sql, []),
    first: async <T>() => invokeFirst<T>(sql, []),
    run: async () => invokeRun(sql, []),
  });

  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const statement of stmts) {
        await statement.run();
      }
      return [];
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  return { db, queries };
}

describe("handleBackfillMintBurnPrices", () => {
  it("repairs rows missing valuation audit fields, not only NULL amount_usd rows", async () => {
    const { db, queries } = makeBackfillDb();
    const request = new Request("https://x/api/backfill-mint-burn-prices", {
      headers: { "X-Admin-Key": "secret" },
    });

    const response = await handleBackfillMintBurnPrices(
      db,
      new URL("https://x/api/backfill-mint-burn-prices"),
      "secret",
      request,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      totalUpdated: number;
      coins: Array<{ id: string; updated: number }>;
    };
    expect(body.totalUpdated).toBe(2);
    expect(body.coins).toEqual([{ id: "1", updated: 2 }]);

    const selectSql = queries.find(
      (q) => q.kind === "all" && q.sql.includes("SELECT DISTINCT stablecoin_id FROM mint_burn_events"),
    )?.sql;
    expect(selectSql).toContain("amount_usd IS NULL");
    expect(selectSql).toContain("price_used IS NULL");
    expect(selectSql).toContain("price_timestamp IS NULL");
    expect(selectSql).toContain("price_source IS NULL");

    const updateSql = queries.find(
      (q) => q.kind === "run" && q.sql.includes("UPDATE mint_burn_events"),
    )?.sql;
    expect(updateSql).toContain("amount_usd = COALESCE(amount_usd, amount * ?)");
    expect(updateSql).toContain("price_used = COALESCE(price_used, ?)");
    expect(updateSql).toContain("price_timestamp = COALESCE(price_timestamp, ?)");
    expect(updateSql).toContain("price_source = COALESCE(price_source, 'backfill-price-cache')");
    expect(updateSql).toContain("amount_usd IS NULL");
    expect(updateSql).toContain("price_used IS NULL");
    expect(updateSql).toContain("price_timestamp IS NULL");
    expect(updateSql).toContain("price_source IS NULL");
  });

  it("requires admin auth", async () => {
    const { db } = makeBackfillDb();

    const response = await handleBackfillMintBurnPrices(
      db,
      new URL("https://x/api/backfill-mint-burn-prices"),
      "secret",
      new Request("https://x/api/backfill-mint-burn-prices"),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });
});
