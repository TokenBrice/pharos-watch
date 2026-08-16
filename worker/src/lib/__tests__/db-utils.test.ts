import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchExecute,
  buildPaginatedQuery,
  chunkArray,
  executeAtomicBatch,
  getFirstSeenDates,
  getLastBlock,
  normalizeBlacklistSyncStateKey,
  prepareMultiRowInsertStatements,
  setLastBlock,
} from "../db";
import {
  getCache,
  getPriceCache,
  savePriceCache,
  setCache,
  setCacheIfNewer,
  writeFreshnessSentinel,
} from "../db-cache";

type CacheRow = { value: string; updated_at: number };

function makeDb(opts?: {
  cache?: Map<string, CacheRow>;
  lastBlocks?: Map<string, number>;
  priceRows?: Array<{ asset_id: string; price: number; updated_at: number }>;
  firstSeenRows?: Array<{ stablecoin_id: string; first_seen: number }>;
  setCacheIfNewerChanges?: number;
  transientFailures?: Record<string, number>;
}) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const batchCalls: D1PreparedStatement[][] = [];
  const transientFailures = new Map(Object.entries(opts?.transientFailures ?? {}));

  const maybeThrowTransientFailure = (sql: string) => {
    for (const [pattern, remaining] of transientFailures) {
      if (remaining <= 0 || !sql.includes(pattern)) continue;
      transientFailures.set(pattern, remaining - 1);
      throw new Error("D1 DB is overloaded");
    }
  };

  const db = {
    prepare: (sql: string) => {
      const runForSql = async () => {
        maybeThrowTransientFailure(sql);
        if (sql.includes("ON CONFLICT(key) DO UPDATE")) {
          return { success: true, meta: { changes: opts?.setCacheIfNewerChanges ?? 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      };

      const firstForSql = async <T>(args: unknown[]) => {
        maybeThrowTransientFailure(sql);
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
        maybeThrowTransientFailure(sql);
        if (sql.includes("FROM blacklist_sync_state") && sql.includes("IN (")) {
          const rows = (args as string[])
            .map((key) => {
              const last = opts?.lastBlocks?.get(key);
              return last == null ? null : ({ config_key: key, last_block: last } as T);
            })
            .filter((row): row is T => row != null);
          return { results: rows, success: true, meta: {} };
        }
        if (sql.includes("source, confidence, observed_at")) {
          return {
            results: (opts?.priceRows ?? []).map((r) => ({
              ...r,
              source: null,
              confidence: null,
              observed_at: null,
              observed_at_mode: null,
              synced_at: null,
              agree_sources_json: null,
              consensus_sources_json: null,
            })) as T[],
            success: true,
            meta: {},
          };
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

  it("executes a bounded atomic batch in one D1 transaction", async () => {
    const { db, batchCalls } = makeDb();
    const stmts = Array.from({ length: 100 }, () => ({}) as D1PreparedStatement);

    await executeAtomicBatch(db, stmts);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(100);
    await expect(executeAtomicBatch(db, [...stmts, {} as D1PreparedStatement])).rejects.toThrow(
      "at most 100 statements",
    );
  });

  it("retries an overloaded atomic batch and preserves per-statement results for CAS callers", async () => {
    const results = [
      { success: true, results: [{ total: 2 }], meta: { changes: 0 } },
      { success: true, results: [], meta: { changes: 1 } },
    ] as D1Result[];
    const batch = vi.fn()
      .mockRejectedValueOnce(new Error("D1 DB is overloaded"))
      .mockResolvedValueOnce(results);
    const db = { batch } as unknown as D1Database;
    const statements = [{}, {}] as D1PreparedStatement[];

    const pending = executeAtomicBatch(db, statements, { returnResults: true });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(results);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenNthCalledWith(1, statements);
    expect(batch).toHaveBeenNthCalledWith(2, statements);
  });

  it("packs multi-row inserts under the D1 bind limit", () => {
    const { db, calls } = makeDb();
    const rows = Array.from({ length: 26 }, (_, index) => [
      `coin-${index}`,
      1_700_000_000,
      index,
      1,
    ] as const);

    const statements = prepareMultiRowInsertStatements(
      db,
      "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price)",
      rows,
    );

    expect(statements).toHaveLength(2);
    expect(calls.map((call) => call.args.length)).toEqual([100, 4]);
  });

  it("does not start batch execution when the abort signal is already aborted", async () => {
    const { db, batchCalls } = makeDb();
    const stmts = Array.from({ length: 2 }, () => ({}) as D1PreparedStatement);
    const controller = new AbortController();
    controller.abort(new Error("batch aborted"));

    await expect(batchExecute(db, stmts, { chunkSize: 1, signal: controller.signal })).rejects.toThrow(
      "batch aborted",
    );
    expect(batchCalls).toHaveLength(0);
  });

  it("stops batch execution between chunks when the abort signal fires", async () => {
    const controller = new AbortController();
    const batchCalls: D1PreparedStatement[][] = [];
    const db = {
      prepare: () => {
        throw new Error("prepare unused");
      },
      batch: async (stmts: D1PreparedStatement[]) => {
        batchCalls.push(stmts);
        controller.abort(new Error("batch stopped"));
        return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
      },
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;
    const stmts = Array.from({ length: 3 }, () => ({}) as D1PreparedStatement);

    await expect(batchExecute(db, stmts, { chunkSize: 1, signal: controller.signal })).rejects.toThrow(
      "batch stopped",
    );
    expect(batchCalls).toHaveLength(1);
  });

  it("uses the shared chunkArray implementation while preserving the D1 default", () => {
    expect(chunkArray([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunkArray(Array.from({ length: 91 }, (_, index) => index)).map((chunk) => chunk.length)).toEqual([90, 1]);
    expect(() => chunkArray([1, 2, 3], 1.5)).toThrow(/positive integer chunkSize/);
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

  it("returns written when setCacheIfNewer inserts or updates the cache row", async () => {
    const { db } = makeDb({ setCacheIfNewerChanges: 1 });

    const result = await setCacheIfNewer(db, "stablecoins", '{"x":1}', 1700000000);

    expect(result).toEqual({ written: true, skippedBecauseNewer: false });
  });

  it("returns skipped outcome and logs when setCacheIfNewer skips write due to fresher row", async () => {
    const { db } = makeDb({ setCacheIfNewerChanges: 0 });
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = await setCacheIfNewer(db, "stablecoins", '{"x":1}', 1700000000);

    expect(result).toEqual({ written: false, skippedBecauseNewer: true });
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "cache_write_skipped_newer",
      metadata: { key: "stablecoins", syncStartSec: 1700000000 },
    });
    logSpy.mockRestore();
  });

  it("refuses cache publication when the signal is already aborted", async () => {
    const { db, calls } = makeDb();
    const controller = new AbortController();
    controller.abort(new Error("publication aborted"));

    await expect(setCacheIfNewer(db, "stablecoins", '{"x":1}', 1700000000, controller.signal))
      .rejects.toThrow("publication aborted");
    await expect(writeFreshnessSentinel(db, "dews", 1700000000, controller.signal))
      .rejects.toThrow("publication aborted");

    expect(calls).toEqual([]);
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

  it("retries blacklist cursor helpers after transient D1 overload", async () => {
    const { db } = makeDb({
      lastBlocks: new Map([["ethereum-0xabc", 100]]),
      transientFailures: {
        "SELECT config_key, last_block": 1,
        "INSERT OR REPLACE INTO blacklist_sync_state": 1,
      },
    });

    const read = getLastBlock(db, "ethereum-0xAbC");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(read).resolves.toBe(100);

    const write = setLastBlock(db, "ethereum-0xAbC", 101);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(write).resolves.toBeUndefined();
  });

  it("honors abort signals before blacklist cursor retries start", async () => {
    const { db, calls } = makeDb();
    const controller = new AbortController();
    controller.abort(new Error("cursor aborted"));

    await expect(getLastBlock(db, "ethereum-0xAbC", controller.signal)).rejects.toThrow("cursor aborted");
    await expect(setLastBlock(db, "ethereum-0xAbC", 101, controller.signal)).rejects.toThrow("cursor aborted");
    expect(calls).toEqual([]);
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
      observedAtMode: null,
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
      observedAtMode: null,
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

  it("retries first-seen supply history reads after transient D1 overload", async () => {
    const { db } = makeDb({
      firstSeenRows: [
        { stablecoin_id: "usdt-tether", first_seen: 1690000000 },
      ],
      transientFailures: {
        "MIN(snapshot_date)": 1,
      },
    });

    const read = getFirstSeenDates(db);
    await vi.advanceTimersByTimeAsync(1_000);
    const firstSeen = await read;

    expect(firstSeen.get("usdt-tether")).toBe(1690000000);
  });

  it("uses a fresh first-seen cache row when available", async () => {
    const { db, calls } = makeDb({
      cache: new Map([
        [
          "supply-history:first-seen-dates",
          {
            value: JSON.stringify({
              version: 1,
              firstSeenById: {
                "usdt-tether": 1690000000,
                "usdc-circle": 1680000000,
              },
            }),
            updated_at: Math.floor(Date.now() / 1000),
          },
        ],
      ]),
      firstSeenRows: [
        { stablecoin_id: "ignored", first_seen: 1 },
      ],
    });

    const firstSeen = await getFirstSeenDates(db);
    expect(firstSeen.get("usdt-tether")).toBe(1690000000);
    expect(firstSeen.get("usdc-circle")).toBe(1680000000);
    expect(calls.some((call) => call.sql.includes("MIN(snapshot_date)"))).toBe(false);
  });

  it("adds priced observations to a fresh first-seen cache without querying supply history", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { db, calls } = makeDb({
      cache: new Map([
        [
          "supply-history:first-seen-dates",
          {
            value: JSON.stringify({
              version: 1,
              firstSeenById: {
                "usdt-tether": 1690000000,
              },
            }),
            updated_at: nowSec,
          },
        ],
      ]),
      firstSeenRows: [
        { stablecoin_id: "ignored", first_seen: 1 },
      ],
    });

    const firstSeen = await getFirstSeenDates(db, [
      { id: "new-priced-asset", observedAtSec: 1700000000 },
      { id: "future-priced-asset", observedAtSec: nowSec + 600 },
      { id: "bad-observation", observedAtSec: null },
    ]);

    expect(firstSeen.get("usdt-tether")).toBe(1690000000);
    expect(firstSeen.get("new-priced-asset")).toBe(1700000000);
    expect(firstSeen.get("future-priced-asset")).toBe(nowSec);
    expect(firstSeen.has("bad-observation")).toBe(false);
    expect(calls.some((call) => call.sql.includes("MIN(snapshot_date)"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(true);
  });

  it("merges stale cached price anchors with supply-history anchors", async () => {
    const { db } = makeDb({
      cache: new Map([
        [
          "supply-history:first-seen-dates",
          {
            value: JSON.stringify({
              version: 1,
              firstSeenById: {
                "priced-only": 1700000000,
                "history-asset": 1700000000,
              },
            }),
            updated_at: 1,
          },
        ],
      ]),
      firstSeenRows: [
        { stablecoin_id: "history-asset", first_seen: 1690000000 },
        { stablecoin_id: "history-only", first_seen: 1680000000 },
      ],
    });

    const firstSeen = await getFirstSeenDates(db);
    expect(firstSeen.get("priced-only")).toBe(1700000000);
    expect(firstSeen.get("history-asset")).toBe(1690000000);
    expect(firstSeen.get("history-only")).toBe(1680000000);
  });
});
