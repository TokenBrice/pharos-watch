import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleHealth } from "../health";

describe("handleHealth", () => {
  it("returns 200 with health status", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
    ]);
    const res = await handleHealth(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      timestamp: number;
      warnings: string[];
      caches: Record<string, unknown>;
      blacklist: {
        totalEvents: number;
        missingAmounts: number;
        recentMissingAmounts: number;
        recentWindowSec: number;
        missingRatio: number;
      };
      mintBurn: {
        totalEvents: number;
        latestEventTs: number | null;
        latestHourlyTs: number | null;
        freshnessAgeSec: number | null;
        majorStaleCount: number;
        staleMajorSymbols: string[];
        sync: {
          lastSuccessfulSyncAt: number | null;
          freshnessStatus: "fresh" | "degraded" | "stale";
          warning: string | null;
          criticalLaneHealthy: boolean;
        };
      };
      circuits: Record<string, unknown>;
    };
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("warnings");
    expect(body).toHaveProperty("caches");
    expect(body).toHaveProperty("blacklist");
    expect(body).toHaveProperty("mintBurn");
    expect(body).toHaveProperty("circuits");
    expect(body.blacklist).toMatchObject({
      totalEvents: 0,
      missingAmounts: 0,
      recentMissingAmounts: 0,
      missingRatio: 0,
    });
    expect(body.mintBurn.totalEvents).toBe(1234);
    expect(body.warnings).toEqual([]);
    expect(body.mintBurn).toHaveProperty("latestEventTs");
    expect(body.mintBurn).toHaveProperty("latestHourlyTs");
    expect(body.mintBurn).toHaveProperty("freshnessAgeSec");
    expect(body.mintBurn).toHaveProperty("majorStaleCount");
    expect(body.mintBurn).toHaveProperty("staleMajorSymbols");
    expect(body.mintBurn).toHaveProperty("sync");
    expect(["healthy", "degraded", "stale"]).toContain(body.status);
  });

  it("returns Cache-Control: no-store", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
    ]);
    const res = await handleHealth(db);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not mark quiet majors stale when the critical lane is syncing on time", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          { key: "stablecoins", updated_at: now - 60, value: "{}" },
          { key: "stablecoin-charts", updated_at: now - 60, value: "{}" },
          { key: "usds-status", updated_at: now - 60, value: "{}" },
          { key: "fx-rates", updated_at: now - 60, value: JSON.stringify({ peggedEUR: 1.08 }) },
          { key: "bluechip-ratings", updated_at: now - 60, value: "{}" },
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
      { match: "SELECT MAX(timestamp) as latest FROM mint_burn_events", rows: [], first: { latest: now - 30 } },
      { match: "SELECT MAX(hour_ts) as latest FROM mint_burn_hourly", rows: [], first: { latest: now - 3600 } },
      {
        match: "SELECT symbol, MAX(timestamp) as latest",
        rows: [
          { symbol: "USDT", latest: now - 2 * 3600 },
          { symbol: "GHO", latest: now - 8 * 3600 },
          { symbol: "BOLD", latest: now - 9 * 3600 },
          { symbol: "reUSD", latest: now - 12 * 3600 },
        ],
      },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 600 } },
    ]);

    const res = await handleHealth(db);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
      mintBurn: {
        majorStaleCount: number;
        staleMajorSymbols: string[];
        sync: {
          freshnessStatus: "fresh" | "degraded" | "stale";
          warning: string | null;
          criticalLaneHealthy: boolean;
        };
      };
    };

    expect(body.status).toBe("healthy");
    expect(body.warnings).toEqual([]);
    expect(body.mintBurn.majorStaleCount).toBe(0);
    expect(body.mintBurn.staleMajorSymbols).toEqual([]);
    expect(body.mintBurn.sync.freshnessStatus).toBe("fresh");
    expect(body.mintBurn.sync.warning).toBeNull();
    expect(body.mintBurn.sync.criticalLaneHealthy).toBe(true);
  });

  it("returns stale with warnings when the DB health sentinel fails", async () => {
    const db = mockD1([
      { match: "SELECT 1", rows: [], throwError: new Error("db down") },
    ]);

    const res = await handleHealth(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
      caches: Record<string, unknown>;
    };

    expect(body.status).toBe("stale");
    expect(body.caches).toEqual({});
    expect(body.warnings[0]).toContain("db-unhealthy:");
  });

  it("degrades and surfaces warnings when subqueries fail", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          { key: "stablecoins", updated_at: now - 60, value: "{}" },
          { key: "stablecoin-charts", updated_at: now - 60, value: "{}" },
          { key: "usds-status", updated_at: now - 60, value: "{}" },
          { key: "fx-rates", updated_at: now - 60, value: JSON.stringify({ peggedEUR: 1.08 }) },
          { key: "bluechip-ratings", updated_at: now - 60, value: "{}" },
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "blacklist_events", rows: [], throwError: new Error("blacklist failed") },
      { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
      { match: "SELECT MAX(timestamp) as latest FROM mint_burn_events", rows: [], first: { latest: now - 30 } },
      { match: "SELECT MAX(hour_ts) as latest FROM mint_burn_hourly", rows: [], first: { latest: now - 3600 } },
      {
        match: "SELECT symbol, MAX(timestamp) as latest",
        rows: [{ symbol: "USDT", latest: now - 600 }],
      },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
    ]);

    const res = await handleHealth(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
    };

    expect(body.status).toBe("degraded");
    expect(body.warnings.some((warning) => warning.startsWith("blacklist-query-failed:"))).toBe(true);
  });

  it("keeps health degraded rather than stale when FX is in repeated cached-fallback with fresh usable sync", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          { key: "stablecoins", updated_at: now - 60, value: "{}" },
          { key: "stablecoin-charts", updated_at: now - 60, value: "{}" },
          { key: "usds-status", updated_at: now - 60, value: "{}" },
          { key: "fx-rates", updated_at: now - 60, value: JSON.stringify({ peggedEUR: 1.08 }) },
          {
            key: "fx-rates-meta",
            updated_at: now - 60,
            value: JSON.stringify({
              usableSyncAt: now - 60,
              mode: "cached-fallback",
              sourceUpdatedAtByPeg: { peggedEUR: now - 8 * 3600 },
              sourceModeByPeg: { peggedEUR: "cached" },
              sourceCadenceByPeg: { peggedEUR: "intraday" },
              consecutiveFallbackRuns: 4,
            }),
          },
          { key: "bluechip-ratings", updated_at: now - 60, value: "{}" },
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
      { match: "SELECT MAX(timestamp) as latest FROM mint_burn_events", rows: [], first: { latest: now - 30 } },
      { match: "SELECT MAX(hour_ts) as latest FROM mint_burn_hourly", rows: [], first: { latest: now - 3600 } },
      { match: "SELECT symbol, MAX(timestamp) as latest", rows: [{ symbol: "USDT", latest: now - 600 }] },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
    ]);

    const res = await handleHealth(db);
    const body = (await res.json()) as { status: string; warnings: string[]; caches: Record<string, { mode?: string; sourceStatus?: string }> };

    expect(body.status).toBe("degraded");
    expect(body.caches["fx-rates"]).toMatchObject({
      mode: "cached-fallback",
      sourceStatus: "degraded",
    });
    expect(body.warnings.some((warning) => warning.includes("cached fallback FX rates"))).toBe(true);
  });

  it("includes telegramSummary when telegram tables exist", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      { match: "telegram_subscribers", rows: [], first: { n: 42 } },
      { match: "telegram_pending_alerts", rows: [], first: { n: 3 } },
      { match: "dispatch-telegram-alerts", rows: [], first: { started_at: now - 120, status: "ok" } },
    ]);
    const res = await handleHealth(db);
    const body = (await res.json()) as { telegramSummary: { totalChats: number; pendingDeliveries: number; lastDispatchAt: number | null; lastDispatchStatus: string | null } | null };
    expect(body.telegramSummary).toEqual({
      totalChats: 42,
      pendingDeliveries: 3,
      lastDispatchAt: now - 120,
      lastDispatchStatus: "ok",
    });
  });

  it("returns null telegramSummary when telegram tables do not exist", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      { match: "telegram_subscribers", rows: [], throwError: new Error("no such table: telegram_subscribers") },
    ]);
    const res = await handleHealth(db);
    const body = (await res.json()) as { telegramSummary: unknown };
    expect(body.telegramSummary).toBeNull();
  });
});
