import { afterEach, describe, expect, it } from "vitest";
import {
  handleStatus,
  makeCacheRow,
  makeCronRow,
  cleanupStatusTest,
  fixtureMockD1,
  fixtureMakeApiRequest,
  fixtureCRON_INTERVALS,
} from "./status.test-support";

describe("handleStatus", () => {
  afterEach(cleanupStatusTest);
  it("returns Cache-Control: no-store", async () => {
    const db = fixtureMockD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("includes cron health data in the response", async () => {
    const db = fixtureMockD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      crons: Record<string, { lastRun: unknown; healthy: boolean; expectedIntervalSec: number }>;
    };

    expect(body.crons).toHaveProperty("sync-stablecoins");
    const syncStablecoins = body.crons["sync-stablecoins"];
    expect(syncStablecoins).toHaveProperty("lastRun");
    expect(syncStablecoins).toHaveProperty("healthy");
    expect(syncStablecoins).toHaveProperty("expectedIntervalSec");
    expect(body.crons["sync-blacklist"]?.expectedIntervalSec).toBe(6 * 3600);
    expect(body.crons["sync-dex-discovery"]?.expectedIntervalSec).toBe(2 * 3600);
    expect(body.crons["sync-live-reserves"]?.expectedIntervalSec).toBe(4 * 3600);
    expect(body.crons["sync-yield-data"]?.expectedIntervalSec).toBe(3600);
    expect(body.crons["sync-yield-supplemental"]?.expectedIntervalSec).toBe(4 * 3600);
    expect(body.crons["prune-status-probe-runs"]?.expectedIntervalSec).toBe(86400);
  });

  it("includes budget-only scheduled surface telemetry in status", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "FROM cache",
        matchBinds: [
          "cron:budget-surface:telegram-registration-reconciliation",
          "cron:budget-surface:alert-broker-delivery-drain",
          "cron:budget-surface:digest-trigger-poll",
        ],
        rows: [
          {
            key: "cron:budget-surface:digest-trigger-poll",
            updated_at: now - 45,
            value: JSON.stringify({
              version: 1,
              surface: "digest-trigger-poll",
              checkedAt: now - 45,
              durationMs: 64,
              dueCount: 0,
              processedCount: 0,
              outcome: "skipped",
              skippedReason: "no-pending-request",
            }),
          },
        ],
      },
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins"), makeCacheRow("stablecoin-charts")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      { match: "cache", rows: [], first: { value: JSON.stringify({ peggedAssets: [] }), updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status?refresh=live", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      budgetOnlySurfaces: Array<{
        job: string;
        telemetryStatus: string;
        outcome: string;
        skippedReason?: string | null;
      }>;
      summary: { budgetOnlySurfaceCount?: number; budgetOnlySurfaceMissingTelemetry?: number };
    };
    expect(body.budgetOnlySurfaces).toEqual([
      expect.objectContaining({
        job: "telegram-registration-reconciliation",
        telemetryStatus: "missing",
        outcome: "unknown",
      }),
      expect.objectContaining({
        job: "alert-broker-delivery-drain",
        telemetryStatus: "missing",
        outcome: "unknown",
      }),
      expect.objectContaining({
        job: "digest-trigger-poll",
        telemetryStatus: "fresh",
        outcome: "skipped",
        skippedReason: "no-pending-request",
      }),
    ]);
    expect(body.summary.budgetOnlySurfaceCount).toBe(3);
    expect(body.summary.budgetOnlySurfaceMissingTelemetry).toBe(2);
  });

  it("includes in-flight cron progress when a leased job is still running", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("dispatch-telegram-alerts", "ok", 30)] },
      {
        match: "cron_leases",
        rows: [{ job: "dispatch-telegram-alerts", lease_owner: "lease-123", lease_until: now + 600 }],
      },
      {
        match: "cron_run_progress",
        rows: [
          {
            job: "dispatch-telegram-alerts",
            started_at: now - 120,
            updated_at: now - 10,
            stage: "pending-drain",
            items_done: 2,
            items_total: 7,
            message: "Draining due Telegram pending rows",
            lease_owner: "lease-123",
            metadata: JSON.stringify({
              providerFamily: "telegram-api",
              phase: "pending-drain",
              countTotals: { pendingAttempted: 2, pendingTotal: 7 },
              cursor: { queue: "telegram_pending_alerts" },
              deferredTail: { total: 7, due: 2, deferred: 5, oldestPendingAgeSec: 120 },
            }),
          },
        ],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      crons: Record<
        string,
        {
          inFlight?: {
            stage?: string;
            stale: boolean;
            itemsDone?: number;
            itemsTotal?: number;
            metadata?: Record<string, unknown>;
          } | null;
        }
      >;
    };

    expect(body.crons["dispatch-telegram-alerts"]?.inFlight).toMatchObject({
      stage: "pending-drain",
      stale: false,
      itemsDone: 2,
      itemsTotal: 7,
      metadata: {
        providerFamily: "telegram-api",
        phase: "pending-drain",
        countTotals: { pendingAttempted: 2, pendingTotal: 7 },
        cursor: { queue: "telegram_pending_alerts" },
        deferredTail: { total: 7, due: 2, deferred: 5, oldestPendingAgeSec: 120 },
      },
    });
  });

  it("treats a fresh in-flight recovery run as healthy even if the last completed run errored", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const jobs = Object.keys(fixtureCRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => makeCronRow(job, job === "sync-blacklist" ? "error" : "ok", 30)),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = fixtureMockD1([
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
        match: "cron_leases",
        rows: [{ job: "sync-blacklist", lease_owner: "lease-456", lease_until: now + 600 }],
      },
      {
        match: "cron_run_progress",
        rows: [
          {
            job: "sync-blacklist",
            started_at: now - 120,
            updated_at: now - 10,
            stage: "scan-config",
            items_done: 4,
            items_total: 7,
            message: "Scanning USDT on Ethereum",
            lease_owner: "lease-456",
            metadata: JSON.stringify({ budgetUsed: 31, budgetLimit: 900 }),
          },
        ],
      },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 1000, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      summary: { unhealthyCrons: number; cronErrors: number };
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["sync-blacklist"]?.healthy).toBe(true);
    expect(body.summary.unhealthyCrons).toBe(0);
    expect(body.summary.cronErrors).toBe(0);
    expect(body.availabilityStatus).toBe("healthy");
  });

  it("ignores orphaned in-flight progress when the lease is no longer active", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-blacklist", "error", 30)] },
      { match: "cron_leases", rows: [] },
      {
        match: "cron_run_progress",
        rows: [
          {
            job: "sync-blacklist",
            started_at: now - 120,
            updated_at: now - 10,
            stage: "scan-config",
            items_done: 4,
            items_total: 7,
            message: "Scanning USDT on Ethereum",
            lease_owner: "stale-lease",
            metadata: JSON.stringify({ budgetUsed: 31, budgetLimit: 900 }),
          },
        ],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      crons: Record<string, { healthy: boolean; inFlight?: unknown | null }>;
      summary: { unhealthyCrons: number };
      availabilityStatus: string;
    };

    expect(body.crons["sync-blacklist"]?.inFlight).toBeNull();
    expect(body.crons["sync-blacklist"]?.healthy).toBe(false);
    expect(body.summary.unhealthyCrons).toBeGreaterThan(0);
    expect(body.availabilityStatus).toBe("stale");
  });

  it("keeps availability healthy when only a watch-tier cron is unhealthy", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const cronRows = Object.keys(fixtureCRON_INTERVALS).map((job) =>
      makeCronRow(job, job === "sync-live-reserves" ? "error" : "ok", 60),
    );
    const db = fixtureMockD1([
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
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      summary: {
        unhealthyCrons: number;
        availabilityImpactingUnhealthyCrons: number;
        watchUnhealthyCrons: number;
        availabilityImpactingCronErrors: number;
      };
      causes: { availability: Array<{ code: string; severity: string }> };
    };

    expect(body.availabilityStatus).toBe("healthy");
    expect(body.summary.unhealthyCrons).toBe(1);
    expect(body.summary.availabilityImpactingUnhealthyCrons).toBe(0);
    expect(body.summary.watchUnhealthyCrons).toBe(1);
    expect(body.summary.availabilityImpactingCronErrors).toBe(0);
    expect(
      body.causes.availability.some(
        (cause) => cause.code === "watch_unhealthy_crons_present" && cause.severity === "info",
      ),
    ).toBe(true);
  });

  it("includes Telegram bot subscriber stats when Telegram tables are present", async () => {
    const db = fixtureMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("dispatch-telegram-alerts", "ok", 60)] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      {
        match: "FROM telegram_subscribers s",
        rows: [],
        first: {
          total_chats: 12,
          alert_enabled_chats: 10,
          deliverable_chats: 9,
          subscribed_chats: 11,
          empty_alert_chats: 1,
          muted_chats_with_subscriptions: 2,
          dews_chats: 8,
          depeg_chats: 7,
          safety_chats: 6,
          launch_chats: 5,
          all_types_chats: 5,
          total_subscriptions: 37,
          avg_subscriptions_per_subscribed_chat: 3.36,
          last_subscriber_activity_at: 1772000000,
        },
      },
      {
        match: "FROM telegram_pending_disambiguation",
        rows: [],
        first: { pending_count: 3 },
      },
      {
        match: "FROM telegram_pending_alerts",
        rows: [],
        first: { pending_count: 4 },
      },
      {
        match: "GROUP BY stablecoin_id",
        rows: [
          { stablecoin_id: "usdc-circle", subscribers: 7 },
          { stablecoin_id: "usde-ethena", subscribers: 4 },
        ],
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      telegramBot: {
        totalChats: number;
        deliverableChats: number;
        totalSubscriptions: number;
        pendingDisambiguations: number;
        pendingDeliveries: number;
        customPreferenceChats: number;
        quietHoursEnabledChats: number;
        alertTypeChats: {
          dews: number;
          depeg: number;
          safety: number;
          launch: number;
          reserve: number;
          allTypes: number;
        };
        topStablecoins: Array<{
          stablecoinId: string;
          symbol: string;
          subscribers: number;
          explicitSubscribers: number;
          presetImpliedSubscribers: number;
        }>;
      } | null;
    };

    expect(body.telegramBot).not.toBeNull();
    expect(body.telegramBot?.totalChats).toBe(12);
    expect(body.telegramBot?.deliverableChats).toBe(9);
    expect(body.telegramBot?.totalSubscriptions).toBe(37);
    expect(body.telegramBot?.pendingDisambiguations).toBe(3);
    expect(body.telegramBot?.pendingDeliveries).toBe(4);
    expect(body.telegramBot?.customPreferenceChats).toBe(0);
    expect(body.telegramBot?.quietHoursEnabledChats).toBe(0);
    expect(body.telegramBot?.alertTypeChats).toEqual({
      dews: 8,
      depeg: 7,
      safety: 6,
      launch: 5,
      reserve: 0,
      allTypes: 5,
    });
    expect(body.telegramBot?.topStablecoins).toEqual([
      {
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        subscribers: 7,
        explicitSubscribers: 7,
        presetImpliedSubscribers: 0,
      },
      {
        stablecoinId: "usde-ethena",
        symbol: "USDe",
        subscribers: 4,
        explicitSubscribers: 4,
        presetImpliedSubscribers: 0,
      },
    ]);
  });

  it("returns telegramBot=null when Telegram tables are unavailable", async () => {
    const db = fixtureMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 100)] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      {
        match: "FROM telegram_subscribers s",
        rows: [],
        throwError: "no such table: telegram_subscribers",
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as { telegramBot: unknown };

    expect(res.status).toBe(200);
    expect(body.telegramBot).toBeNull();
  });

  it("surfaces subsection loader failures through sectionErrors", async () => {
    const db = fixtureMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 100)] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      {
        match: "FROM discovery_candidates WHERE dismissed = 0",
        rows: [],
        throwError: "discovery query exploded",
      },
      {
        match: "FROM telegram_subscribers s",
        rows: [],
        throwError: "no such table: telegram_subscribers",
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
      discoveryCandidates: unknown;
      telegramBot: unknown;
    };

    expect(body.discoveryCandidates).toBeNull();
    expect(body.telegramBot).toBeNull();
    expect(body.sectionErrors.discoveryCandidates).toEqual({
      code: "discovery_candidates_query_failed",
      message: "Discovery candidates unavailable.",
    });
    expect(body.sectionErrors.telegramBot).toEqual({
      code: "telegram_bot_stats_query_failed",
      message: "Telegram bot diagnostics unavailable.",
    });
  });

  it("marks status degraded and skips data-quality queries when DB sentinel fails", async () => {
    const db = fixtureMockD1([
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
            first: async () => {
              throw new Error("db down");
            },
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async () => ({ results: [], success: true, meta: {} }),
          first: async () => {
            throw new Error("db down");
          },
          run: async () => ({ success: true, meta: {} }),
        } as unknown as D1PreparedStatement;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
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
    const db = fixtureMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      {
        match: "cron_runs",
        rows: [makeCronRow("sync-stablecoins", "skipped_locked", 30), makeCronRow("sync-stablecoins", "ok", 90)],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["sync-stablecoins"]?.healthy).toBe(true);
  });

  it("treats fresh degraded cron runs as warning-only (not availability unhealthy)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const jobs = Object.keys(fixtureCRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => makeCronRow(job, job === "fetch-tbill-rate" ? "degraded" : "ok", 30)),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = fixtureMockD1([
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
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
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
});
