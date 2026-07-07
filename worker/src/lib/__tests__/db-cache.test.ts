import { afterEach, describe, expect, it, vi } from "vitest";
import { getPriceCache, savePriceCache } from "../db-cache";

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

function makeDb(options: {
  fullRows?: FullPriceCacheRow[];
  fullError?: Error;
}) {
  const queries: string[] = [];

  const db = {
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
  } as unknown as D1Database;

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
    expect(warn).toHaveBeenCalledWith(
      "[db-cache] Full-column price_cache query failed:",
      "D1_ERROR: no such column: agree_sources_json",
    );
  });

  it("does not fallback when the full-schema query fails unexpectedly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("network connection reset");
    const { db, queries } = makeDb({ fullError: error });

    await expect(getPriceCache(db)).rejects.toThrow("network connection reset");

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("source, confidence, observed_at");
    expect(warn).toHaveBeenCalledWith("[db-cache] Full-column price_cache query failed:", "network connection reset");
  });
});

describe("savePriceCache", () => {
  it("bounds cache freshness timestamps to the local sync time", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...bindings: unknown[]) => {
          statements.push({ sql, bindings });
          return { sql, bindings };
        },
      }),
      batch: async () => [{ success: true, meta: { changes: 1 }, results: [] }],
    } as unknown as D1Database;

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
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...bindings: unknown[]) => {
          statements.push({ sql, bindings });
          return { sql, bindings };
        },
      }),
      batch: async () => [{ success: true, meta: { changes: 1 }, results: [] }],
    } as unknown as D1Database;

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

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("ON CONFLICT(asset_id) DO UPDATE");
    expect(statements[0].sql).toContain("excluded.synced_at");
    expect(statements[0].bindings[2]).toBe(1800000000);
    expect(statements[0].bindings[7]).toBe(1800000100);
  });
});
