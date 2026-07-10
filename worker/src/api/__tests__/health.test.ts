import { describe, it, expect, vi } from "vitest";
import type { FreshnessStatus } from "@shared/lib/status-thresholds";
import { mockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { handleHealth } from "../health";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";

type HealthDbOptions = {
  extraCacheRows?: Record<string, unknown>[];
  dexAge?: number;
  blacklistEntry?: MockTableConfig;
  symbolRows?: Record<string, unknown>[];
  statusStartedAt?: number;
  extras?: MockTableConfig[];
};

function completePublicationEntry(now: number): MockTableConfig {
  return {
    match: "job = 'sync-stablecoins' AND metadata IS NOT NULL",
    rows: [],
    first: {
      started_at: now - 30,
      metadata: JSON.stringify({
        activePublicationCoverage: {
          complete: true,
          expectedActiveCount: ACTIVE_IDS.size,
          presentActiveCount: ACTIVE_IDS.size,
          waivedActiveCount: 0,
          missingActiveIds: [],
          waivedActiveIds: [],
          expiredWaiverIds: [],
        },
      }),
    },
  };
}

function dewsPublicationEntry(now: number): MockTableConfig {
  const updatedAt = now - 60;
  const row = {
    key: "dews:published-generation",
    updated_at: updatedAt,
    value: JSON.stringify({
      updatedAt,
      source: "compute-dews",
      publishStatus: "published",
      coverageVersion: 2,
      expectedRowCount: 1,
      stablecoinIdsDigest: "a".repeat(64),
    }),
  };
  return {
    match: "FROM cache WHERE key = ?",
    matchBinds: ["dews:published-generation"],
    rows: [row],
    first: row,
  };
}

function makeHealthyHealthDb(now: number, options: HealthDbOptions = {}) {
  const {
    extraCacheRows = [],
    dexAge = 60,
    blacklistEntry = { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
    symbolRows = [{ symbol: "USDT", latest: now - 600 }],
    statusStartedAt = now - 300,
    extras = [],
  } = options;

  return mockD1([
    completePublicationEntry(now),
    dewsPublicationEntry(now),
    {
      match: "cache WHERE key IN",
      rows: [
        { key: "stablecoins", updated_at: now - 60, value: "{}" },
        { key: "stablecoin-charts", updated_at: now - 60, value: "{}" },
        { key: "usds-status", updated_at: now - 60, value: "{}" },
        { key: "fx-rates", updated_at: now - 60, value: JSON.stringify({ peggedEUR: 1.08 }) },
        { key: "bluechip-ratings", updated_at: now - 60, value: "{}" },
        ...extraCacheRows,
      ],
    },
    { match: "dex_liquidity", rows: [], first: { age: dexAge } },
    { match: "yield_data", rows: [], first: { age: 60 } },
    { match: "stress_signals", rows: [], first: { age: 60 } },
    blacklistEntry,
    { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
    { match: "SELECT MAX(timestamp) as latest FROM mint_burn_events", rows: [], first: { latest: now - 30 } },
    { match: "SELECT MAX(hour_ts) as latest FROM mint_burn_hourly", rows: [], first: { latest: now - 3600 } },
    { match: "SELECT symbol, MAX(timestamp) as latest", rows: symbolRows },
    { match: "SELECT status", rows: [], first: { status: "ok" } },
    { match: "status = 'ok'", rows: [], first: { started_at: statusStartedAt } },
    ...extras,
  ]);
}

describe("handleHealth", () => {
  it("returns 200 with health status", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      completePublicationEntry(now),
      dewsPublicationEntry(now),
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      {
        match: "item_count, metadata",
        rows: [],
        first: { item_count: 4321, metadata: JSON.stringify({ rowCount: 4321 }) },
      },
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
        totalEvents: number | null;
        latestEventTs: number | null;
        latestHourlyTs: number | null;
        freshnessAgeSec: number | null;
        majorStaleCount: number;
        staleMajorSymbols: string[];
        sync: {
          lastSuccessfulSyncAt: number | null;
          freshnessStatus: FreshnessStatus;
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
    expect(body.mintBurn.totalEvents).toBe(4321);
    expect(body.warnings).toEqual([]);
    expect(body.mintBurn).toHaveProperty("latestEventTs");
    expect(body.mintBurn).toHaveProperty("latestHourlyTs");
    expect(body.mintBurn).toHaveProperty("freshnessAgeSec");
    expect(body.mintBurn).toHaveProperty("majorStaleCount");
    expect(body.mintBurn).toHaveProperty("staleMajorSymbols");
    expect(body.mintBurn).toHaveProperty("sync");
    expect(["healthy", "degraded", "stale"]).toContain(body.status);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM mint_burn_events"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM mint_burn_hourly"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("sqlite_sequence"))).toBe(false);
  });

  it("returns the bounded realtime Cache-Control profile", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
    ]);
    const res = await handleHealth(db);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, max-age=10");
  });

  it("does not mark quiet majors stale when the critical lane is syncing on time", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      symbolRows: [
        { symbol: "USDT", latest: now - 2 * 3600 },
        { symbol: "GHO", latest: now - 8 * 3600 },
        { symbol: "BOLD", latest: now - 9 * 3600 },
        { symbol: "reUSD", latest: now - 12 * 3600 },
      ],
      statusStartedAt: now - 600,
    });

    const res = await handleHealth(db);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
      mintBurn: {
        majorStaleCount: number;
        staleMajorSymbols: string[];
        sync: {
          freshnessStatus: FreshnessStatus;
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

  it("surfaces sentinel fallback metadata when a freshness sentinel is invalid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      dexAge: 45,
      extraCacheRows: [
        {
          key: "freshness:dex-liquidity",
          updated_at: now - 120,
          value: JSON.stringify({
            updatedAt: now - 120,
            source: "sync-yield-data",
            publishStatus: "ok",
          }),
        },
        {
          key: "freshness:yield-data",
          updated_at: now - 180,
          value: JSON.stringify({
            updatedAt: now - 180,
            source: "sync-yield-data",
            publishStatus: "ok",
          }),
        },
        {
          key: "freshness:dews",
          updated_at: now - 240,
          value: JSON.stringify({
            updatedAt: now - 240,
            source: "compute-dews",
            publishStatus: "ok",
          }),
        },
      ],
    });

    const res = await handleHealth(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      warnings: string[];
      caches: Record<
        string,
        {
          ageSeconds: number | null;
          freshnessSource?: string;
          sentinelValidationReason?: string;
          warning?: string;
        }
      >;
    };

    expect(body.caches["dex-liquidity"]).toMatchObject({
      ageSeconds: 45,
      freshnessSource: "table-fallback",
      sentinelValidationReason: "wrong-source",
      warning: "dex-liquidity: freshness sentinel invalid (wrong-source); using table-fallback",
    });
    expect(body.warnings).toContain("dex-liquidity: freshness sentinel invalid (wrong-source); using table-fallback");
  });

  it("returns stale with warnings when the DB health sentinel fails", async () => {
    const db = mockD1([{ match: "SELECT 1", rows: [], throwError: new Error("db down") }]);

    const res = await handleHealth(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
      caches: Record<string, unknown>;
    };

    expect(body.status).toBe("stale");
    expect(body.caches).toEqual({});
    expect(body.warnings).toContain("db-unhealthy");
  });

  it("degrades and surfaces warnings when subqueries fail", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      blacklistEntry: { match: "blacklist_events", rows: [], throwError: new Error("blacklist failed") },
    });

    const res = await handleHealth(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
    };

    expect(body.status).toBe("degraded");
    expect(body.warnings).toContain("blacklist-query-failed");
    expect(body.warnings.join(" ")).not.toContain("blacklist failed");
  });

  it("keeps health degraded rather than stale when FX is in repeated cached-fallback with fresh usable sync", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      extraCacheRows: [
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
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as {
      status: string;
      warnings: string[];
      caches: Record<string, { mode?: string; sourceStatus?: string }>;
    };

    expect(body.status).toBe("degraded");
    expect(body.caches["fx-rates"]).toMatchObject({
      mode: "cached-fallback",
      sourceStatus: "degraded",
    });
    expect(body.warnings.some((warning) => warning.includes("cached fallback FX rates"))).toBe(true);
  });

  it("degrades when three or more circuit groups are open", async () => {
    const now = Math.floor(Date.now() / 1000);
    const openCircuitValue = (openedAt: number) =>
      JSON.stringify({
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: openedAt - 30,
        lastSuccessAt: null,
        openedAt,
      });
    const db = makeHealthyHealthDb(now, {
      extras: [
        {
          match: "key LIKE 'circuit:%'",
          rows: [
            { key: "circuit:defillama-stablecoins", value: openCircuitValue(now - 600) },
            { key: "circuit:coingecko-prices", value: openCircuitValue(now - 540) },
            { key: "circuit:dexscreener-prices", value: openCircuitValue(now - 480) },
          ],
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      circuits: Record<string, { state: string }>;
    };

    expect(body.status).toBe("degraded");
    expect(Object.values(body.circuits).filter((circuit) => circuit.state === "open")).toHaveLength(3);
  });

  it("keeps public health healthy when only live-reserve circuit groups are open", async () => {
    const now = Math.floor(Date.now() / 1000);
    const openCircuitValue = (openedAt: number) =>
      JSON.stringify({
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: openedAt - 30,
        lastSuccessAt: null,
        openedAt,
      });
    const db = makeHealthyHealthDb(now, {
      extras: [
        {
          match: "key LIKE 'circuit:%'",
          rows: [
            { key: "circuit:live-reserves:ethena", value: openCircuitValue(now - 600) },
            { key: "circuit:live-reserves:feusd-felix", value: openCircuitValue(now - 540) },
            { key: "circuit:live-reserves:mtbill-midas", value: openCircuitValue(now - 480) },
          ],
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      circuits: Record<string, { state: string }>;
    };

    expect(body.status).toBe("healthy");
    expect(Object.values(body.circuits).filter((circuit) => circuit.state === "open")).toHaveLength(3);
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
      {
        match: "dispatch-telegram-alerts",
        rows: [],
        first: {
          started_at: now - 120,
          status: "ok",
          metadata: JSON.stringify({
            safetyAlertSourceState: "ok",
            safetyAlertSourceAgeSeconds: 120,
            safetyAlertsSuppressed: false,
            safetyAlertSourceGeneration: "safety-7.09-alert-source-v1",
          }),
        },
      },
    ]);
    const res = await handleHealth(db);
    const body = (await res.json()) as {
      telegramSummary: {
        totalChats: number;
        pendingDeliveries: number;
        lastDispatchAt: number | null;
        lastDispatchStatus: string | null;
        safetyAlertSourceState: string | null;
        safetyAlertSourceAgeSeconds: number | null;
        safetyAlertsSuppressed: boolean;
        safetyAlertSourceGeneration: string | null;
      } | null;
    };
    expect(body.telegramSummary).toEqual({
      totalChats: 42,
      pendingDeliveries: 3,
      lastDispatchAt: now - 120,
      lastDispatchStatus: "ok",
      safetyAlertSourceState: "ok",
      safetyAlertSourceAgeSeconds: 120,
      safetyAlertsSuppressed: false,
      safetyAlertSourceGeneration: "safety-7.09-alert-source-v1",
    });
  });

  it("keeps telegramSummary counts when the last dispatch metadata is malformed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      { match: "telegram_subscribers", rows: [], first: { n: 42 } },
      { match: "telegram_pending_alerts", rows: [], first: { n: 3 } },
      {
        match: "dispatch-telegram-alerts",
        rows: [],
        first: { started_at: now - 120, status: "ok", metadata: "{bad-json" },
      },
    ]);

    const res = await handleHealth(db);
    const body = (await res.json()) as {
      telegramSummary: {
        totalChats: number;
        pendingDeliveries: number;
        lastDispatchAt: number | null;
        lastDispatchStatus: string | null;
        safetyAlertSourceState: string | null;
        safetyAlertSourceAgeSeconds: number | null;
        safetyAlertsSuppressed: boolean;
        safetyAlertSourceGeneration: string | null;
      } | null;
    };

    expect(body.telegramSummary).toEqual({
      totalChats: 42,
      pendingDeliveries: 3,
      lastDispatchAt: now - 120,
      lastDispatchStatus: "ok",
      safetyAlertSourceState: null,
      safetyAlertSourceAgeSeconds: null,
      safetyAlertsSuppressed: false,
      safetyAlertSourceGeneration: null,
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("adds a warning when safety alerts are suppressed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      { match: "telegram_subscribers", rows: [], first: { n: 42 } },
      { match: "telegram_pending_alerts", rows: [], first: { n: 3 } },
      {
        match: "dispatch-telegram-alerts",
        rows: [],
        first: {
          started_at: now - 120,
          status: "degraded",
          metadata: JSON.stringify({
            safetyAlertSourceState: "wrong-generation",
            safetyAlertSourceAgeSeconds: 120,
            safetyAlertsSuppressed: true,
            safetyAlertSourceGeneration: "legacy-generation",
          }),
        },
      },
    ]);

    const res = await handleHealth(db);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toContain("telegram-safety-alerts-suppressed:wrong-generation");
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

  it("filters stale removed live-reserve circuit keys from the health payload", async () => {
    const now = Math.floor(Date.now() / 1000);
    const openCircuitValue = (openedAt: number) =>
      JSON.stringify({
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: openedAt - 30,
        lastSuccessAt: null,
        openedAt,
      });
    const db = makeHealthyHealthDb(now, {
      extras: [
        {
          match: "key LIKE 'circuit:%'",
          rows: [
            { key: "circuit:live-reserves:pmusd-precious-metals", value: openCircuitValue(now - 600) },
            { key: "circuit:live-reserves:ethena", value: openCircuitValue(now - 600) },
          ],
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as {
      circuits: Record<string, { state: string }>;
    };

    expect(body.circuits["live-reserves:pmusd-precious-metals"]).toBeUndefined();
    expect(body.circuits["live-reserves:ethena"]?.state).toBe("open");
  });
});
