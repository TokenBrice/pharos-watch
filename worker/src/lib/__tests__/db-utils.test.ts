import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchExecute,
  buildPaginatedQuery,
  getFirstSeenDates,
  getLastBlock,
  normalizeBlacklistSyncStateKey,
  setLastBlock,
} from "../db";
import {
  getCache,
  getPriceCache,
  savePriceCache,
  setCache,
  setCacheIfNewer,
} from "../db-cache";

type CacheRow = { value: string; updated_at: number };

function makeDb(opts?: {
  cache?: Map<string, CacheRow>;
  lastBlocks?: Map<string, number>;
  priceRows?: Array<{ asset_id: string; price: number; updated_at: number }>;
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
          return (opts?.cache?.get(key) ?? null) as T | null;
        }
        if (sql.includes("SELECT last_block FROM blacklist_sync_state")) {
          const key = String(args[0] ?? "");
          const last = opts?.lastBlocks?.get(key);
          return (last == null ? null : { last_block: last }) as T | null;
        }
        return null as T | null;
      };

      const allForSql = async <T>(args: unknown[]) => {
        if (sql.includes("FROM blacklist_sync_state") && sql.includes("IN (")) {
          const rows = (args as string[])
            .map((key) => {
              const last = opts?.lastBlocks?.get(key);
              return last == null ? null : ({ config_key: key, last_block: last } as T);
            })
            .filter((row): row is T => row != null);
          return { results: rows, success: true, meta: {} };
        }
        if (sql.includes("SELECT asset_id, price, updated_at FROM price_cache")) {
          return { results: (opts?.priceRows ?? []) as T[], success: true, meta: {} };
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
            all: () => allForSql(args),
          };
        },
        run: runForSql,
        first: () => firstForSql([]),
        all: () => allForSql([]),
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
      cache: new Map([["stablecoins", { value: '{"ok":true}', updated_at: 1700000000 }]]),
    });
    await expect(getCache(withCache.db, "stablecoins")).resolves.toEqual({
      value: '{"ok":true}',
      updatedAt: 1700000000,
    });

    const noCache = makeDb();
    await expect(getCache(noCache.db, "stablecoins")).resolves.toBeNull();
  });

  it("setCache writes updated_at using current unix seconds", async () => {
    const { db, calls } = makeDb();
    await setCache(db, "stablecoins", '{"x":1}');

    const write = calls.find((c) => c.sql.includes("INSERT OR REPLACE INTO cache"));
    expect(write).toBeDefined();
    expect(write?.args[0]).toBe("stablecoins");
    expect(write?.args[1]).toBe('{"x":1}');
    expect(write?.args[2]).toBe(Math.floor(Date.now() / 1000));
  });

  it("logs when setCacheIfNewer skips write due to fresher row", async () => {
    const { db } = makeDb({ setCacheIfNewerChanges: 0 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await setCacheIfNewer(db, "stablecoins", '{"x":1}', 1700000000);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Skipped write for "stablecoins"'));
    logSpy.mockRestore();
  });

  it("returns last synced block or 0 when absent", async () => {
    const withRow = makeDb({ lastBlocks: new Map([["eth", 12345]]) });
    await expect(getLastBlock(withRow.db, "eth")).resolves.toBe(12345);

    const withoutRow = makeDb();
    await expect(getLastBlock(withoutRow.db, "eth")).resolves.toBe(0);
  });

  it("merges blacklist cursor variants by choosing the highest matching block", async () => {
    const { db } = makeDb({
      lastBlocks: new Map([
        ["ethereum-0xabc", 100],
        ["ethereum-0xAbC", 75],
      ]),
    });

    await expect(getLastBlock(db, "ethereum-0xAbC")).resolves.toBe(100);
  });

  it("normalizes EVM blacklist cursor keys on write but preserves Tron keys", async () => {
    const { db, calls } = makeDb();

    await setLastBlock(db, "ethereum-0xAbCDEF", 123);
    await setLastBlock(db, "tron-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 456);

    const writes = calls.filter((call) => call.sql.includes("INSERT OR REPLACE INTO blacklist_sync_state"));
    expect(writes[0]?.args).toEqual(["ethereum-0xabcdef", 123]);
    expect(writes[1]?.args).toEqual(["tron-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 456]);
    expect(normalizeBlacklistSyncStateKey("ethereum-0xAbCDEF")).toBe("ethereum-0xabcdef");
  });

  it("returns price cache map and supports empty save fast-path", async () => {
    const { db, batchCalls } = makeDb({
      priceRows: [
        { asset_id: "usdt-tether", price: 1.01, updated_at: 1700000000 },
        { asset_id: "usdc-circle", price: 0.99, updated_at: 1700000100 },
      ],
    });

    const map = await getPriceCache(db);
    expect(map.get("usdt-tether")).toEqual({
      price: 1.01,
      updatedAt: 1700000000,
      source: null,
      confidence: null,
      observedAt: 1700000000,
      syncedAt: 1700000000,
      agreeSources: [],
      consensusSources: [],
    });
    expect(map.get("usdc-circle")).toEqual({
      price: 0.99,
      updatedAt: 1700000100,
      source: null,
      confidence: null,
      observedAt: 1700000100,
      syncedAt: 1700000100,
      agreeSources: [],
      consensusSources: [],
    });

    await savePriceCache(db, []);
    expect(batchCalls).toHaveLength(0);
  });

  it("batches price-cache upserts", async () => {
    const { db, batchCalls } = makeDb();

    await savePriceCache(db, [
      { id: "usdt-tether", price: 1.0 },
      { id: "usdc-circle", price: 0.9 },
    ]);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(2);
  });

  it("returns first-seen date map", async () => {
    const { db } = makeDb({
      firstSeenRows: [
        { stablecoin_id: "usdt-tether", first_seen: 1690000000 },
        { stablecoin_id: "usdc-circle", first_seen: 1680000000 },
      ],
    });

    const firstSeen = await getFirstSeenDates(db);
    expect(firstSeen.get("usdt-tether")).toBe(1690000000);
    expect(firstSeen.get("usdc-circle")).toBe(1680000000);
  });
});
