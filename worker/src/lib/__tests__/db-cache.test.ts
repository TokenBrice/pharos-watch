import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import {
  getCache, getPriceCache, prepareCacheUpsert, readCacheWithPolicy, savePriceCache,
  setCacheIfAbsent, setCacheIfNewer, setCachesAt, shouldSkipFreshCache, type CachePolicy,
} from "../db-cache";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

interface FullPriceCacheRow {
  asset_id: string;
  price: number;
  updated_at: number;
  source: string | null;
  confidence: "high" | "single-source" | "low" | "fallback" | null;
  observed_at: number | null;
  observed_at_mode: "upstream" | "local_fetch" | "unknown" | null;
  synced_at: number | null;
  agree_sources_json: string | null;
  consensus_sources_json: string | null;
}

describe("setCacheIfAbsent", () => {
  it("preserves the first value and timestamp on a key conflict", async () => {
    const { sqlite, db } = fixtures.open();

    expect(await setCacheIfAbsent(db, "write-once", "first", 100)).toBe(true);
    expect(await setCacheIfAbsent(db, "write-once", "second", 200)).toBe(false);
    expect(sqlite.prepare(
      "SELECT value, updated_at FROM cache WHERE key = 'write-once'",
    ).get()).toEqual({ value: "first", updated_at: 100 });
  });
});

describe("cache conflict updates", () => {
  it("overwrites every value and clock unconditionally without replacing an existing key", async () => {
    const { sqlite, db } = fixtures.open();
    await prepareCacheUpsert(db, { key: "current", value: "initial", updatedAt: 200 }).run();
    sqlite.prepare("INSERT INTO cache VALUES ('rowid-anchor', '{}', 1)").run();
    const original = sqlite.prepare("SELECT rowid FROM cache WHERE key = 'current'").get();
    for (const [value, updatedAt] of [["older", 100], ["equal", 100], ["equal", 300]] as const) {
      await prepareCacheUpsert(db, { key: "current", value, updatedAt }).run();
      expect(await getCache(db, "current")).toEqual({ value, updatedAt });
      expect(sqlite.prepare("SELECT rowid FROM cache WHERE key = 'current'").get()).toEqual(original);
    }
  });

  it("retains inclusive if-newer admission and advances unchanged-payload freshness", async () => {
    const { db } = fixtures.open();
    await setCacheIfNewer(db, "current", "initial", 200);
    expect(await setCacheIfNewer(db, "current", "older", 199))
      .toEqual({ written: false, skippedBecauseNewer: true });
    expect(await getCache(db, "current")).toEqual({ value: "initial", updatedAt: 200 });
    expect(await setCacheIfNewer(db, "current", "equal", 200))
      .toEqual({ written: true, skippedBecauseNewer: false });
    expect(await setCacheIfNewer(db, "current", "equal", 201))
      .toEqual({ written: true, skippedBecauseNewer: false });
    expect(await getCache(db, "current")).toEqual({ value: "equal", updatedAt: 201 });
  });

  it("rolls back earlier current-row updates when a later batched update fails", async () => {
    const { sqlite, db } = fixtures.open();
    await setCachesAt(db, [{ key: "first", value: "old" }, { key: "second", value: "old" }], 200);
    sqlite.exec(`CREATE TRIGGER reject_second_cache_update BEFORE UPDATE ON cache
      WHEN NEW.key = 'second' BEGIN SELECT RAISE(ABORT, 'cache update rejected'); END`);
    await expect(setCachesAt(db, [
      { key: "first", value: "new" }, { key: "second", value: "new" },
    ], 100)).rejects.toThrow("cache update rejected");
    expect(await getCache(db, "first")).toEqual({ value: "old", updatedAt: 200 });
    expect(await getCache(db, "second")).toEqual({ value: "old", updatedAt: 200 });
  });

  it("does not start a default-mode batch after cancellation", async () => {
    const { db } = fixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    const controller = new AbortController();
    controller.abort(new Error("cache publication aborted"));
    await expect(setCachesAt(db, [{ key: "current", value: "new" }], 100, { signal: controller.signal }))
      .rejects.toThrow("cache publication aborted");
    expect(prepare).not.toHaveBeenCalled();
  });
});

function makeDb(options: {
  fullRows?: FullPriceCacheRow[];
  fullError?: Error;
}) {
  const queries: string[] = [];

  const db = makeNoopD1({
    prepare: (sql: string) => {
      queries.push(sql);
      return {
        all: async <T>() => {
          const isFullPriceCacheQuery = sql.includes("source, confidence, observed_at");
          if (isFullPriceCacheQuery) {
            if (options.fullError) throw options.fullError;
            return { results: (options.fullRows ?? []) as T[], success: true, meta: {} };
          }
          return { results: [] as T[], success: true, meta: {} };
        },
      };
    },
  });

  return { db, queries };
}

describe("getPriceCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns metadata from the full-schema query", async () => {
    const { db, queries } = makeDb({
      fullRows: [
        {
          asset_id: "usdc-circle",
          price: 0.9998,
          updated_at: 1800000000,
          source: "coingecko",
          confidence: "high",
          observed_at: 1799999900,
          observed_at_mode: "upstream",
          synced_at: 1800000010,
          agree_sources_json: JSON.stringify(["coingecko", "defillama"]),
          consensus_sources_json: JSON.stringify(["coingecko"]),
        },
      ],
    });

    const cache = await getPriceCache(db);

    expect(cache.get("usdc-circle")).toEqual({
      price: 0.9998,
      updatedAt: 1800000000,
      source: "coingecko",
      confidence: "high",
      observedAt: 1799999900,
      observedAtMode: "upstream",
      syncedAt: 1800000010,
      agreeSources: ["coingecko", "defillama"],
      consensusSources: ["coingecko"],
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("source, confidence, observed_at");
  });

  it("falls back to empty source arrays when cached source JSON is malformed", async () => {
    const { db } = makeDb({
      fullRows: [
        {
          asset_id: "usdc-circle",
          price: 0.9998,
          updated_at: 1800000000,
          source: "coingecko",
          confidence: "high",
          observed_at: 1799999900,
          observed_at_mode: "upstream",
          synced_at: 1800000010,
          agree_sources_json: "{bad-json",
          consensus_sources_json: JSON.stringify({ not: "array" }),
        },
      ],
    });

    const cache = await getPriceCache(db);

    expect(cache.get("usdc-circle")?.agreeSources).toEqual([]);
    expect(cache.get("usdc-circle")?.consensusSources).toEqual([]);
  });

  it("propagates missing metadata-column errors without fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, queries } = makeDb({
      fullError: new Error("D1_ERROR: no such column: agree_sources_json"),
    });

    await expect(getPriceCache(db)).rejects.toThrow("no such column: agree_sources_json");

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("source, confidence, observed_at");
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: "price_cache_full_column_query_failed",
      errorMessage: "D1_ERROR: no such column: agree_sources_json",
    });
  });

});

describe("readCacheWithPolicy", () => {
  const policy: CachePolicy<{ count: number }> = {
    key: "policy-test", storage: "d1-kv", schemaId: "count:v1", ttlSec: 30,
    stale: "reject", invalid: "retain",
    decode: JSON.parse, encode: JSON.stringify,
  };

  it.each([30, null])("keeps timestamp admission independent of TTL %s", async (ttlSec) => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run(policy.key, '{"count":4}', 160);
    expect(await readCacheWithPolicy(db, { ...policy, ttlSec }, 100)).toMatchObject({ state: "fresh", usable: true });
    insert.run(policy.key, '{"count":4}', 161);
    expect(await readCacheWithPolicy(db, { ...policy, ttlSec, stale: "accept" }, 100)).toMatchObject({
      state: "invalid", value: null, usable: false, reason: "future-timestamp",
    });
    insert.run(policy.key, '{"count":4}', 1);
    expect(await readCacheWithPolicy(db, { ...policy, ttlSec }, 100)).toMatchObject({
      state: ttlSec == null ? "fresh" : "stale", usable: ttlSec == null,
    });
  });

  it("applies invalid deletion to an invalid clock", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(policy.key, '{"count":4}', 161);
    expect(await readCacheWithPolicy(db, { ...policy, invalid: "delete" }, 100)).toMatchObject({
      state: "invalid", reason: "future-timestamp",
    });
    expect(await getCache(db, policy.key)).toBeNull();
  });

  it("accepts the exact TTL and applies stale accept versus reject one second later", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(policy.key, '{"count":4}', 100);
    expect(await readCacheWithPolicy(db, policy, 130))
      .toEqual({ state: "fresh", value: { count: 4 }, updatedAt: 100, usable: true });
    expect(await readCacheWithPolicy(db, policy, 131))
      .toEqual({ state: "stale", value: { count: 4 }, updatedAt: 100, usable: false });
    expect(await readCacheWithPolicy(db, { ...policy, stale: "accept" }, 131))
      .toEqual({ state: "stale", value: { count: 4 }, updatedAt: 100, usable: true });
  });

  it.each(["throw", "null"] as const)("applies retain versus delete when decoding returns %s", async (mode) => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(policy.key, "invalid", 100);
    const decode = () => {
      if (mode === "throw") throw new Error("invalid payload");
      return null;
    };
    for (const invalid of ["retain", "delete"] as const) {
      expect(await readCacheWithPolicy(db, { ...policy, decode, invalid }, 101))
        .toEqual({ state: "invalid", value: null, updatedAt: 100, usable: false });
      expect(await getCache(db, policy.key)).toEqual(invalid === "retain"
        ? { value: "invalid", updatedAt: 100 } : null);
    }
  });

  it("returns missing without decoding an absent key", async () => {
    const { db } = fixtures.open();
    const decode = vi.fn(() => { throw new Error("absent"); });
    expect(await readCacheWithPolicy(db, { ...policy, decode }, 100))
      .toEqual({ state: "missing", value: null, updatedAt: null, usable: false });
    expect(decode).not.toHaveBeenCalled();
  });

});

describe("shouldSkipFreshCache", () => {
  const NOW_SEC = 1_700_000_000;

  it("rejects a future-dated clock instead of treating it as fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    try {
      const { sqlite, db } = fixtures.open();
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run("bluechip-ratings", "{}", NOW_SEC + 86_400);
      expect(await shouldSkipFreshCache(db, "bluechip-ratings", 6 * 3600)).toBe(false);
      // The if-newer producer write would keep rejecting a poisoned clock, so
      // the rejected row is dropped rather than left to absorb the refresh.
      expect(await getCache(db, "bluechip-ratings")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the configured budget for an admitted clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    try {
      const { sqlite, db } = fixtures.open();
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run("bluechip-ratings", "{}", NOW_SEC - 6 * 3600 + 1);
      expect(await shouldSkipFreshCache(db, "bluechip-ratings", 6 * 3600)).toBe(true);
      sqlite.prepare("UPDATE cache SET updated_at = ? WHERE key = ?")
        .run(NOW_SEC - 6 * 3600, "bluechip-ratings");
      expect(await shouldSkipFreshCache(db, "bluechip-ratings", 6 * 3600)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("savePriceCache", () => {
  it("bounds cache freshness timestamps to the local sync time", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = makeNoopD1({
      prepare: (sql: string) => ({
        bind: (...bindings: unknown[]) => {
          statements.push({ sql, bindings });
          return { sql, bindings };
        },
      }),
      batch: async () => [{ success: true, meta: { changes: 1 }, results: [] }],
    });

    await savePriceCache(db, [{
      id: "future-priced-asset",
      price: 1,
      source: "coingecko",
      confidence: "single-source",
      observedAt: 1_800_003_700,
      observedAtMode: "upstream",
      syncedAt: 1_800_000_100,
    }]);

    expect(statements[0].bindings[2]).toBe(1_800_000_100);
    expect(statements[0].bindings[5]).toBe(1_800_003_700);
  });

  it("uses synced_at as the monotonic conflict guard while preserving observed_at as updated_at", async () => {
    const { db } = fixtures.open();

    await savePriceCache(db, [{
      id: "usdc-circle",
      price: 0.9999,
      source: "coingecko+pyth",
      confidence: "high",
      observedAt: 1800000000,
      observedAtMode: "upstream",
      syncedAt: 1800000100,
      agreeSources: ["coingecko", "pyth"],
      consensusSources: ["coingecko", "pyth"],
    }]);

    const expected = {
      price: 0.9999, updatedAt: 1800000000, source: "coingecko+pyth", confidence: "high",
      observedAt: 1800000000, observedAtMode: "upstream", syncedAt: 1800000100,
      agreeSources: ["coingecko", "pyth"], consensusSources: ["coingecko", "pyth"],
    };
    await savePriceCache(db, [{
      id: "usdc-circle", price: 0.8, source: "older", observedAt: 1800000050, syncedAt: 1800000099,
    }]);
    expect((await getPriceCache(db)).get("usdc-circle")).toEqual(expected);
    await savePriceCache(db, [{
      id: "usdc-circle", price: 1.01, source: "equal", observedAt: 1799999999, syncedAt: 1800000100,
    }]);
    expect((await getPriceCache(db)).get("usdc-circle")).toEqual({
      price: 1.01, updatedAt: 1799999999, source: "equal", confidence: null,
      observedAt: 1799999999, observedAtMode: null, syncedAt: 1800000100,
      agreeSources: [], consensusSources: [],
    });
  });
});
