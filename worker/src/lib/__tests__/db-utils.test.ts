import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchExecute,
  buildPaginatedQuery,
  getCache,
  getFirstSeenDates,
  getLastBlock,
  getOnchainSupply,
  getPriceCache,
  savePriceCache,
  setCache,
  setCacheIfNewer,
  upsertOnchainSupply,
} from "../db";

type CacheRow = { value: string; updated_at: number };

function makeDb(opts?: {
  cache?: Map<string, CacheRow>;
  lastBlocks?: Map<string, number>;
  priceRows?: Array<{ asset_id: string; price: number; updated_at: number }>;
  onchainRows?: Array<{ stablecoin_id: string; chain: string; supply: number; updated_at: number }>;
  firstSeenRows?: Array<{ stablecoin_id: string; first_seen: number }>;
  setCacheIfNewerChanges?: number;
}) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const batchCalls: D1PreparedStatement[][] = [];

  const db = {
    prepare: (sql: string) => {
      const runForSql = async () => {
        if (sql.includes("ON CONFLICT(key) DO UPDATE")) {
          return { success: true, meta: { changes: opts?.setCacheIfNewerChanges ?? 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      };

      const firstForSql = async <T>(args: unknown[]) => {
        if (sql.includes("SELECT value, updated_at FROM cache")) {
          const key = String(args[0] ?? "");
          return ((opts?.cache?.get(key) ?? null) as T | null);
        }
        if (sql.includes("SELECT last_block FROM blacklist_sync_state")) {
          const key = String(args[0] ?? "");
          const last = opts?.lastBlocks?.get(key);
          return (last == null ? null : { last_block: last }) as T | null;
        }
        return null as T | null;
      };

      const allForSql = async <T>() => {
        if (sql.includes("SELECT asset_id, price, updated_at FROM price_cache")) {
          return { results: (opts?.priceRows ?? []) as T[], success: true, meta: {} };
        }
        if (sql.includes("SELECT stablecoin_id, chain, supply, updated_at FROM onchain_supply")) {
          return { results: (opts?.onchainRows ?? []) as T[], success: true, meta: {} };
        }
        if (sql.includes("SELECT stablecoin_id, MIN(snapshot_date) as first_seen FROM supply_history")) {
          return { results: (opts?.firstSeenRows ?? []) as T[], success: true, meta: {} };
        }
        return { results: [] as T[], success: true, meta: {} };
      };

      return {
        bind: (...args: unknown[]) => {
        calls.push({ sql, args });
        return {
          run: runForSql,
          first: () => firstForSql(args),
          all: allForSql,
        };
      },
      run: runForSql,
      first: () => firstForSql([]),
      all: allForSql,
    };
    },
    batch: async (stmts: D1PreparedStatement[]) => {
      batchCalls.push(stmts);
      return [];
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  return { db, calls, batchCalls };
}

describe("db utility helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("chunks batch execution by configured chunk size", async () => {
    const { db, batchCalls } = makeDb();
    const stmts = Array.from({ length: 5 }, () => ({}) as D1PreparedStatement);

    await batchExecute(db, stmts, 2);

    expect(batchCalls).toHaveLength(3);
    expect(batchCalls.map((chunk) => chunk.length)).toEqual([2, 2, 1]);
  });

  it("builds paginated query with where + limit + offset", () => {
    const query = buildPaginatedQuery({
      conditions: ["stablecoin_id = ?", "event_type = ?"],
      limit: 50,
      offset: 100,
    });

    expect(query.where).toBe(" WHERE stablecoin_id = ? AND event_type = ?");
    expect(query.limitClause).toBe(" LIMIT ?");
    expect(query.offsetClause).toBe(" OFFSET ?");
    expect(query.paginationBindings).toEqual([50, 100]);
  });

  it("uses LIMIT -1 when only offset is provided", () => {
    const query = buildPaginatedQuery({ conditions: [], limit: 0, offset: 25 });
    expect(query.where).toBe("");
    expect(query.limitClause).toBe(" LIMIT -1");
    expect(query.offsetClause).toBe(" OFFSET ?");
    expect(query.paginationBindings).toEqual([25]);
  });

  it("maps cache row to camelCase and returns null when missing", async () => {
    const withCache = makeDb({
      cache: new Map([["stablecoins", { value: "{\"ok\":true}", updated_at: 1700000000 }]]),
    });
    await expect(getCache(withCache.db, "stablecoins")).resolves.toEqual({
      value: "{\"ok\":true}",
      updatedAt: 1700000000,
    });

    const noCache = makeDb();
    await expect(getCache(noCache.db, "stablecoins")).resolves.toBeNull();
  });

  it("setCache writes updated_at using current unix seconds", async () => {
    const { db, calls } = makeDb();
    await setCache(db, "stablecoins", "{\"x\":1}");

    const write = calls.find((c) => c.sql.includes("INSERT OR REPLACE INTO cache"));
    expect(write).toBeDefined();
    expect(write?.args[0]).toBe("stablecoins");
    expect(write?.args[1]).toBe("{\"x\":1}");
    expect(write?.args[2]).toBe(Math.floor(Date.now() / 1000));
  });

  it("logs when setCacheIfNewer skips write due to fresher row", async () => {
    const { db } = makeDb({ setCacheIfNewerChanges: 0 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await setCacheIfNewer(db, "stablecoins", "{\"x\":1}", 1700000000);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipped write for "stablecoins"')
    );
    logSpy.mockRestore();
  });

  it("returns last synced block or 0 when absent", async () => {
    const withRow = makeDb({ lastBlocks: new Map([["eth", 12345]]) });
    await expect(getLastBlock(withRow.db, "eth")).resolves.toBe(12345);

    const withoutRow = makeDb();
    await expect(getLastBlock(withoutRow.db, "eth")).resolves.toBe(0);
  });

  it("returns price cache map and supports empty save fast-path", async () => {
    const { db, batchCalls } = makeDb({
      priceRows: [
        { asset_id: "1", price: 1.01, updated_at: 1700000000 },
        { asset_id: "2", price: 0.99, updated_at: 1700000100 },
      ],
    });

    const map = await getPriceCache(db);
    expect(map.get("1")).toEqual({ price: 1.01, updatedAt: 1700000000 });
    expect(map.get("2")).toEqual({ price: 0.99, updatedAt: 1700000100 });

    await savePriceCache(db, []);
    expect(batchCalls).toHaveLength(0);
  });

  it("batches price-cache and onchain-supply upserts and supports empty onchain fast-path", async () => {
    const { db, batchCalls } = makeDb();

    await savePriceCache(db, [
      { id: "1", price: 1.0 },
      { id: "2", price: 0.9 },
    ]);
    await upsertOnchainSupply(db, []);
    await upsertOnchainSupply(db, [
      { stablecoinId: "1", chain: "ethereum", supply: 1000 },
    ]);

    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0]).toHaveLength(2);
    expect(batchCalls[1]).toHaveLength(1);
  });

  it("returns mapped onchain supply rows and first-seen date map", async () => {
    const { db } = makeDb({
      onchainRows: [
        { stablecoin_id: "1", chain: "ethereum", supply: 100, updated_at: 1700000000 },
      ],
      firstSeenRows: [
        { stablecoin_id: "1", first_seen: 1690000000 },
        { stablecoin_id: "2", first_seen: 1680000000 },
      ],
    });

    const onchain = await getOnchainSupply(db, 3600);
    expect(onchain).toEqual([
      { stablecoin_id: "1", chain: "ethereum", supply: 100, updated_at: 1700000000 },
    ]);

    const firstSeen = await getFirstSeenDates(db);
    expect(firstSeen.get("1")).toBe(1690000000);
    expect(firstSeen.get("2")).toBe(1680000000);
  });
});
