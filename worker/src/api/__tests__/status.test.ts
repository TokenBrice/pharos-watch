import { describe, it, expect, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

// Stub crypto.subtle for the auth module's timingSafeEqual
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
    const request = new Request("https://x/api/status", {
      headers: { "X-Admin-Key": "wrong-key" },
    });
    const res = await handleStatus(db, "secret-key", request);

    expect(res.status).toBe(401);
  });

  it("returns 200 with status body when authorized", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "1", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
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

    const request = new Request("https://x/api/status", {
      headers: { "X-Admin-Key": "secret-key" },
    });
    const res = await handleStatus(db, "secret-key", request);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timestamp: number;
      overallStatus: string;
      caches: Record<string, unknown>;
      crons: Record<string, unknown>;
      dataQuality: Record<string, unknown>;
    };

    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("overallStatus");
    expect(body).toHaveProperty("caches");
    expect(body).toHaveProperty("crons");
    expect(body).toHaveProperty("dataQuality");
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

    const request = new Request("https://x/api/status", {
      headers: { "X-Admin-Key": "secret-key" },
    });
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

    const request = new Request("https://x/api/status", {
      headers: { "X-Admin-Key": "secret-key" },
    });
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
});
