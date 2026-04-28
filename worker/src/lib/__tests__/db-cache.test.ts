import { afterEach, describe, expect, it, vi } from "vitest";
import { getPriceCache } from "../db-cache";

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

interface CorePriceCacheRow {
  asset_id: string;
  price: number;
  updated_at: number;
}

function makeDb(options: {
  fullRows?: FullPriceCacheRow[];
  coreRows?: CorePriceCacheRow[];
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
          if (sql.includes("SELECT asset_id, price, updated_at FROM price_cache")) {
            return { results: (options.coreRows ?? []) as T[], success: true, meta: {} };
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

  it("uses the core-column fallback only for missing metadata columns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, queries } = makeDb({
      fullError: new Error("D1_ERROR: no such column: agree_sources_json"),
      coreRows: [{ asset_id: "usdt-tether", price: 1.001, updated_at: 1800001000 }],
    });

    const cache = await getPriceCache(db);

    expect(cache.get("usdt-tether")).toEqual({
      price: 1.001,
      updatedAt: 1800001000,
      source: null,
      confidence: null,
      observedAt: 1800001000,
      observedAtMode: null,
      syncedAt: 1800001000,
      agreeSources: [],
      consensusSources: [],
    });
    expect(queries).toHaveLength(2);
    expect(queries[1]).toBe("SELECT asset_id, price, updated_at FROM price_cache");
    expect(warn).toHaveBeenCalledWith("[db-cache] price_cache metadata columns missing; trying core-only fallback");
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
