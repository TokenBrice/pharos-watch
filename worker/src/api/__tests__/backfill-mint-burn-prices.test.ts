import { describe, expect, it } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { handleBackfillMintBurnPrices } from "../backfill-mint-burn-prices";

stubCryptoForAuth();

type QueryRecord = {
  kind: "all" | "first" | "run";
  sql: string;
  args: unknown[];
};

function makeBackfillDb() {
  const queries: QueryRecord[] = [];

  const incompleteRows = [
    {
      id: "missing-usd",
      stablecoin_id: "usdt-tether",
      chain_id: "ethereum",
      amount: 100,
      amount_usd: null,
      timestamp: 1_710_000_123,
      price_used: null,
      price_timestamp: null,
      price_source: null,
    },
    {
      id: "missing-audit",
      stablecoin_id: "usdt-tether",
      chain_id: "ethereum",
      amount: 100,
      amount_usd: 100.2,
      timestamp: 1_710_000_456,
      price_used: null,
      price_timestamp: null,
      price_source: null,
    },
  ];

  const invokeAll = async <T>(sql: string, args: unknown[]) => {
    queries.push({ kind: "all", sql, args });

    if (sql.includes("SELECT id, stablecoin_id, chain_id, amount, amount_usd")) {
      return {
        success: true,
        meta: {},
        results: incompleteRows as T[],
      };
    }
    if (sql.includes("SELECT stablecoin_id, snapshot_date, price FROM supply_history")) {
      return {
        success: true,
        meta: {},
        results: [
          { stablecoin_id: "usdt-tether", snapshot_date: 1_709_942_400, price: 1.002 },
        ] as T[],
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
      return { success: true, meta: { changes: 1 } };
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
      const results = [];
      for (const statement of stmts) {
        results.push(await statement.run());
      }
      return results;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  return { db, queries };
}

describe("handleBackfillMintBurnPrices", () => {
  it("uses historical supply prices for NULL amount_usd rows and only derives audit fields for already-valued rows", async () => {
    const { db, queries } = makeBackfillDb();
    const request = makeApiRequest("/api/backfill-mint-burn-prices", { adminKey: "secret" });

    const response = await handleBackfillMintBurnPrices(
      db,
      makeApiUrl("/api/backfill-mint-burn-prices"),
      true,
      request,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      totalUpdated: number;
      rowsValued: number;
      rowsAudited: number;
      rowsStillUnpriced: number;
      rowsStillMissingAudit: number;
      coins: Array<{
        id: string;
        updated: number;
        valued: number;
        audited: number;
        stillUnpriced: number;
        stillMissingAudit: number;
      }>;
    };

    expect(body.totalUpdated).toBe(2);
    expect(body.rowsValued).toBe(1);
    expect(body.rowsAudited).toBe(1);
    expect(body.rowsStillUnpriced).toBe(0);
    expect(body.rowsStillMissingAudit).toBe(0);
    expect(body.coins).toEqual([
      {
        id: "usdt-tether",
        updated: 2,
        valued: 1,
        audited: 1,
        stillUnpriced: 0,
        stillMissingAudit: 0,
      },
    ]);

    const selectSql = queries.find(
      (q) => q.kind === "all" && q.sql.includes("SELECT id, stablecoin_id, chain_id, amount, amount_usd"),
    )?.sql;
    expect(selectSql).toContain("amount_usd IS NULL");
    expect(selectSql).toContain("price_used IS NULL");
    expect(selectSql).toContain("price_timestamp IS NULL");
    expect(selectSql).toContain("price_source IS NULL");
    expect(selectSql).toContain("ORDER BY stablecoin_id ASC, timestamp DESC, id DESC");

    const historySql = queries.find(
      (q) => q.kind === "all" && q.sql.includes("SELECT stablecoin_id, snapshot_date, price FROM supply_history"),
    )?.sql;
    expect(historySql).toContain("price IS NOT NULL");

    const updateStatements = queries.filter(
      (q) => q.kind === "run" && q.sql.includes("UPDATE mint_burn_events"),
    );
    expect(updateStatements).toHaveLength(2);

    expect(updateStatements[0]?.sql).toContain("SET amount_usd = ?, price_used = ?, price_timestamp = ?, price_source = ?");
    expect(updateStatements[1]?.sql).toContain("SET price_used = ?, price_timestamp = ?, price_source = ?");
    expect(updateStatements.some((q) => q.sql.includes("amount * ?"))).toBe(false);
    expect(queries.some((q) => q.sql.includes("FROM price_cache"))).toBe(false);
  });

  it("requires admin auth", async () => {
    const { db } = makeBackfillDb();

    const response = await handleBackfillMintBurnPrices(
      db,
      makeApiUrl("/api/backfill-mint-burn-prices"),
      undefined,
      makeApiRequest("/api/backfill-mint-burn-prices"),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });
});
