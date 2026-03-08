import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, stubCryptoForAuth } from "./helpers/auth";

stubCryptoForAuth();

const { handleStatus } = await import("../status");

/** Build a mock cache row with a recent updated_at */
function makeCacheRow(key: string, ageSec = 300) {
  return {
    key,
    updated_at: Math.floor(Date.now() / 1000) - ageSec,
    value: JSON.stringify([]),
  };
}

/** Build a mock cron_runs row */
function makeCronRow(job: string, status = "ok", ageSec = 300) {
  return {
    job,
    started_at: Math.floor(Date.now() / 1000) - ageSec,
    duration_ms: 1500,
    status,
    error: null,
    item_count: 100,
    metadata: null,
  };
}

describe("handleStatus", () => {
  it("returns 401 when no admin key is provided", async () => {
    const db = mockD1([]);
    const res = await handleStatus(db, "secret-key", undefined);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when wrong admin key is provided", async () => {
    const db = mockD1([]);
    const request = makeApiRequest("/api/status", { adminKey: "wrong-key" });
    const res = await handleStatus(db, "secret-key", request);

    expect(res.status).toBe(401);
  });

  it("returns 200 with status body when authorized", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });

    const db = mockD1([
      // buildCacheStatuses queries the cache table
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
        ],
      },
      // Table freshness queries (dex-liquidity, yield-data, dews)
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      // cron_runs query
      {
        match: "cron_runs",
        rows: [
          makeCronRow("sync-stablecoins"),
          makeCronRow("sync-stablecoin-charts"),
          makeCronRow("sync-blacklist"),
        ],
      },
      // Data quality: stablecoins cache for missing prices
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      // Data quality: blacklist totals
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 2 } },
      // Data quality: active depegs
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      // Data quality: stale on-chain supply
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      // Data quality: on-chain divergences (empty — no rows)
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, "secret-key", request);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timestamp: number;
      dbHealthy: boolean;
      overallStatus: string;
      caches: Record<string, unknown>;
      crons: Record<string, unknown>;
      dataQuality: Record<string, unknown>;
      datasetFreshness: Record<string, number | null>;
    };

    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("dbHealthy");
    expect(body).toHaveProperty("overallStatus");
    expect(body).toHaveProperty("caches");
    expect(body).toHaveProperty("crons");
    expect(body).toHaveProperty("dataQuality");
    expect(body).toHaveProperty("datasetFreshness");
    expect(typeof body.dbHealthy).toBe("boolean");
    expect(body.datasetFreshness).toHaveProperty("stablecoins");
    expect(body.datasetFreshness).toHaveProperty("mintBurn");
    expect(["healthy", "degraded", "stale"]).toContain(body.overallStatus);
  });

  it("returns Cache-Control: no-store", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, "secret-key", request);

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("includes cron health data in the response", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      {
        match: "cron_runs",
        rows: [makeCronRow("sync-stablecoins", "ok", 100)],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, "secret-key", request);
    const body = (await res.json()) as {
      crons: Record<string, { lastRun: unknown; healthy: boolean; expectedIntervalSec: number }>;
    };

    expect(body.crons).toHaveProperty("sync-stablecoins");
    const syncStablecoins = body.crons["sync-stablecoins"];
    expect(syncStablecoins).toHaveProperty("lastRun");
    expect(syncStablecoins).toHaveProperty("healthy");
    expect(syncStablecoins).toHaveProperty("expectedIntervalSec");
  });

  it("marks status degraded and skips data-quality queries when DB sentinel fails", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
    ]) as D1Database & { prepare: (sql: string) => D1PreparedStatement };

    const seenSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seenSql.push(sql);
      if (sql.trim() === "SELECT 1") {
        return {
          bind: () => ({
            all: async () => ({ results: [], success: true, meta: {} }),
            first: async () => { throw new Error("db down"); },
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async () => ({ results: [], success: true, meta: {} }),
          first: async () => { throw new Error("db down"); },
          run: async () => ({ success: true, meta: {} }),
        } as unknown as D1PreparedStatement;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, "secret-key", request);
    const body = (await res.json()) as {
      dbHealthy: boolean;
      rawOverallStatus: string;
      overallStatus: string;
    };

    expect(res.status).toBe(200);
    expect(body.dbHealthy).toBe(false);
    expect(["degraded", "stale"]).toContain(body.rawOverallStatus);
    expect(["degraded", "stale"]).toContain(body.overallStatus);
    expect(seenSql.some((sql) => sql.includes("FROM depeg_events"))).toBe(false);
    expect(seenSql.some((sql) => sql.includes("FROM onchain_supply"))).toBe(false);
  });

  it("keeps cron healthy when latest run is skipped_locked but a fresh ok run exists", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      {
        match: "cron_runs",
        rows: [
          makeCronRow("sync-stablecoins", "skipped_locked", 30),
          makeCronRow("sync-stablecoins", "ok", 90),
        ],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, "secret-key", request);
    const body = (await res.json()) as {
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["sync-stablecoins"]?.healthy).toBe(true);
  });

  it("treats fresh degraded cron runs as warning-only (not availability unhealthy)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const jobs = [
      "sync-stablecoins",
      "sync-stablecoin-charts",
      "sync-blacklist",
      "sync-mint-burn",
      "sync-dex-liquidity",
      "sync-usds-status",
      "sync-bluechip",
      "sync-fx-rates",
      "daily-digest",
      "snapshot-supply",
      "snapshot-safety-grade-history",
      "stability-index",
      "snapshot-psi",
      "sync-yield-data",
      "fetch-tbill-rate",
      "compute-dews",
      "status-self-check",
      "dispatch-telegram-alerts",
    ];
    const cronRows = jobs.map((job) => makeCronRow(job, job === "fetch-tbill-rate" ? "degraded" : "ok", 30));
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("fx-rates"),
          makeCacheRow("bluechip-ratings"),
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: cronRows },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 1000, missing: 1, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - (5 * 86400), tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, "secret-key", request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      summary: { unhealthyCrons: number; degradedCrons: number };
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["fetch-tbill-rate"]?.healthy).toBe(true);
    expect(body.summary.unhealthyCrons).toBe(0);
    expect(body.summary.degradedCrons).toBe(1);
    expect(body.availabilityStatus).toBe("healthy");
  });

  it("marks on-chain monitor unavailable instead of forcing stale data quality", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      // Latest on-chain update is too old -> monitor unavailable.
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - (5 * 86400), tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, "secret-key", request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      dataQuality: {
        onchainSupplyMonitoring: string;
        staleOnchainSupply: number;
        onchainSupplyDivergences: number;
      };
    };

    expect(body.dataQuality.onchainSupplyMonitoring).toBe("unavailable");
    expect(body.dataQuality.staleOnchainSupply).toBe(0);
    expect(body.dataQuality.onchainSupplyDivergences).toBe(0);
    expect(body.dataQualityStatus).toBe("healthy");
  });

  it("keeps data quality healthy when blacklist gaps are low-ratio and not recent", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 20000, missing: 40, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - (5 * 86400), tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, "secret-key", request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      dataQuality: { blacklistMissingRatio: number; blacklistRecentMissingAmounts: number };
    };

    expect(body.dataQuality.blacklistMissingRatio).toBeCloseTo(0.002, 6);
    expect(body.dataQuality.blacklistRecentMissingAmounts).toBe(0);
    expect(body.dataQualityStatus).toBe("healthy");
  });

  it("excludes intentional Tron blacklist/unblacklist null amounts from blacklist gap metric", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 100, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - (5 * 86400), tracked: 12 } },
    ]) as D1Database & { prepare: (sql: string) => D1PreparedStatement };

    const seenSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seenSql.push(sql);
      return originalPrepare(sql);
    }) as typeof db.prepare;

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, "secret-key", request);
    expect(res.status).toBe(200);

    const blacklistSql = seenSql.find((sql) => sql.includes("FROM blacklist_events")) ?? "";
    expect(blacklistSql).toContain("chain_id = 'tron'");
    expect(blacklistSql).toContain("event_type IN ('blacklist', 'unblacklist')");
  });
});
