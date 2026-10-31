import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  buildTelegramDeliverySliStatus,
  getTelegramBotStats,
  mapTelegramBotStats,
} from "../status/telegram-bot-stats";
import type { TelegramDeliverySliStatus } from "@shared/types/status";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import type { D1Database, D1PreparedStatement } from "@shared/types/cloudflare-runtime";
import { loadTelegramPendingCapacity } from "../../telegram/outbox/pending-capacity";

function unavailableDeliverySli(): TelegramDeliverySliStatus {
  return {
    availability: "unavailable",
    quality: "unavailable",
    freshness: "unknown",
    acceptanceDefinition: "telegram_bot_api_accepted_not_user_receipt",
    rollup: null,
    error: {
      code: "telegram_delivery_sli_query_failed",
      message: "Telegram delivery SLI telemetry unavailable.",
    },
  };
}

describe("Telegram delivery telemetry SQL", () => {
  it("counts execution-unknown delivery rows and uses the oldest ambiguity", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      sqlite.exec(`
        INSERT INTO telegram_deliveries
          (job_id, kind, chat_id, body_hash, state, next_attempt_at, expires_at, created_at, sending_at, done_at)
        VALUES ('alert:x', 'alert', 'v2-chat', 'h', 'unknown', 200, 10000, 200, 200, 4900),
               ('alert:x', 'alert', 'v2-due', 'h', 'pending', 200, 10000, 200, NULL, NULL);
      `);
      const snapshot = await loadTelegramPendingCapacity(createSqliteD1(sqlite), 5_001);
      expect(snapshot).toMatchObject({
        pendingExecutionUnknown: 1,
        freshExecutionUnknown: 0,
        executionUnknown: 1,
        oldestExecutionUnknownAgeSec: 4_801,
        due: 1,
        active: 1,
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("mapTelegramBotStats", () => {
  it("coerces aggregate rows into the public Telegram status shape", () => {
    const result = mapTelegramBotStats({
      now: 1_710_000_100,
      aggregate: {
        total_chats: "12",
        alert_enabled_chats: "10",
        deliverable_chats: "9",
        subscribed_chats: "8",
        empty_alert_chats: "1",
        muted_chats_with_subscriptions: "2",
        dews_chats: "7",
        depeg_chats: "6",
        safety_chats: "5",
        launch_chats: "4",
        reserve_chats: "3",
        freeze_chats: "2",
        all_types_chats: "4",
        total_subscriptions: "30",
        avg_subscriptions_per_subscribed_chat: "3.46",
        last_subscriber_activity_at: "1710000000",
        custom_preference_chats: "3",
        quiet_hours_enabled_chats: "2",
        active_preset_followers: "2",
      },
      pendingDeliveries: { pending_count: "12" },
      pendingCapacity: {
        total: 12,
        active: 11,
        due: 8,
        deferred: 3,
        expired: 1,
        nearTtl: 2,
        sending: 3,
        pendingSending: 1,
        freshSending: 2,
        pendingExecutionUnknown: 1,
        freshExecutionUnknown: 1,
        executionUnknown: 2,
        sentCleanup: 1,
        oldestExecutionUnknownAgeSec: 90,
        executionUnknownSampleLimit: 5_001,
        executionUnknownLowerBound: false,
        oldestPendingAgeSec: 60,
        oldestDuePendingAgeSec: 30,
        estimatedDrainTimeSec: 300,
        drainBudgetPerRun: 1_800,
        dispatchIntervalSec: 300,
      },
      retryErrorClasses: [
        { error_class: "rate_limit", pending_count: "4" },
        { error_class: "server_error", pending_count: "2" },
      ],
      topStablecoins: [
        {
          stablecoin_id: "usdc-circle",
          subscribers: "8",
          explicit_subscribers: "5",
          preset_implied_subscribers: "3",
        },
        { stablecoin_id: "unknown-stablecoin", subscribers: "2" },
      ],
      lifecycleSnapshot: {
        day: "2026-05-13",
        snapshotAt: 1_710_000_100,
        activeWatchers: 10,
        newWatchers: 2,
        churnedWatchers: 1,
        reactivatedWatchers: 0,
        explicitCoinFollows: 30,
        presetImpliedCoinFollows: 12,
        activePresetFollowers: 2,
        alertTypeOptIns: {
          dews: 7,
          depeg: 6,
          safety: 5,
          launch: 4,
          reserve: 3,
          freeze: 2,
          allTypes: 4,
        },
        quietHoursEnabledChats: 2,
        pendingDeliveries: 12,
      },
      deliverySli: unavailableDeliverySli(),
    });

    expect(result).toEqual({
      totalChats: 12,
      alertEnabledChats: 10,
      deliverableChats: 9,
      subscribedChats: 8,
      emptyAlertChats: 1,
      mutedChatsWithSubscriptions: 2,
      totalSubscriptions: 42,
      explicitCoinSubscriptions: 30,
      presetImpliedCoinSubscriptions: 12,
      activePresetFollowers: 2,
      avgSubscriptionsPerSubscribedChat: 3.5,
      pendingDeliveries: 11,
      quality: {
        status: "complete",
        unavailableFields: [],
      },
      lastSubscriberActivityAt: 1710000000,
      customPreferenceChats: 3,
      quietHoursEnabledChats: 2,
      alertTypeChats: {
        dews: 7,
        depeg: 6,
        safety: 5,
        launch: 4,
        reserve: 3,
        freeze: 2,
        allTypes: 4,
      },
      topStablecoins: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          subscribers: 8,
          explicitSubscribers: 5,
          presetImpliedSubscribers: 3,
        },
        {
          stablecoinId: "unknown-stablecoin",
          symbol: "unknown-stablecoin",
          subscribers: 2,
          explicitSubscribers: 2,
          presetImpliedSubscribers: 0,
        },
      ],
      lifecycleSnapshot: {
        date: "2026-05-13",
        snapshotAt: 1710000100,
        activeWatchers: 10,
        newWatchers: 2,
        churnedWatchers: 1,
        reactivatedWatchers: 0,
        explicitCoinFollows: 30,
        presetImpliedCoinFollows: 12,
        activePresetFollowers: 2,
        alertTypeOptIns: {
          dews: 7,
          depeg: 6,
          safety: 5,
          launch: 4,
          reserve: 3,
          freeze: 2,
          allTypes: 4,
        },
        quietHoursEnabledChats: 2,
        pendingDeliveries: 12,
      },
      oldestPendingDeliveryAgeSec: 60,
      oldestDuePendingAgeSec: 30,
      estimatedDrainTimeSec: 300,
      retryErrorClassCounts: {
        rate_limit: 4,
        server_error: 2,
      },
      pendingDeliveryBacklog: {
        claimable: 8,
        due: 8,
        deferred: 3,
        expired: 1,
        nearTtl: 2,
        sending: 3,
        // P2-13 part 3 single-sources both pending and fresh in-flight capacity in the public backlog.
        pendingSending: 1,
        freshSending: 2,
        executionUnknown: 2,
        pendingExecutionUnknown: 1,
        freshExecutionUnknown: 1,
        oldestExecutionUnknownAgeSec: 90,
        executionUnknownSampleLimit: 5001,
        executionUnknownLowerBound: false,
        sentCleanup: 1,
      },
      deliverySli: unavailableDeliverySli(),
    });
  });

  it("falls back to zeroes and nulls for missing or malformed values", () => {
    const result = mapTelegramBotStats({
      aggregate: {
        total_chats: "not-a-number",
        alert_enabled_chats: null,
        deliverable_chats: null,
        subscribed_chats: "",
        empty_alert_chats: null,
        muted_chats_with_subscriptions: null,
        dews_chats: null,
        depeg_chats: null,
        safety_chats: null,
        launch_chats: null,
        reserve_chats: null,
        freeze_chats: null,
        all_types_chats: null,
        total_subscriptions: null,
        avg_subscriptions_per_subscribed_chat: "bad",
        last_subscriber_activity_at: "bad",
        custom_preference_chats: null,
        quiet_hours_enabled_chats: null,
        active_preset_followers: null,
      },
      pendingDeliveries: { pending_count: "bad" },
      topStablecoins: [{ stablecoin_id: "usdt-tether", subscribers: "bad" }],
      deliverySli: unavailableDeliverySli(),
    });

    expect(result).toEqual({
      totalChats: 0,
      alertEnabledChats: 0,
      deliverableChats: 0,
      subscribedChats: 0,
      emptyAlertChats: 0,
      mutedChatsWithSubscriptions: 0,
      // P2-12 publishes unavailable preset-derived totals as null rather than fabricating zero.
      totalSubscriptions: null,
      explicitCoinSubscriptions: 0,
      presetImpliedCoinSubscriptions: null,
      activePresetFollowers: 0,
      avgSubscriptionsPerSubscribedChat: 0,
      pendingDeliveries: 0,
      quality: {
        status: "complete",
        unavailableFields: [],
      },
      lastSubscriberActivityAt: null,
      customPreferenceChats: 0,
      quietHoursEnabledChats: 0,
      alertTypeChats: {
        dews: 0,
        depeg: 0,
        safety: 0,
        launch: 0,
        reserve: 0,
        freeze: 0,
        allTypes: 0,
      },
      topStablecoins: [
        {
          stablecoinId: "usdt-tether",
          symbol: "USDT",
          subscribers: 0,
          explicitSubscribers: 0,
          presetImpliedSubscribers: 0,
        },
      ],
      deliverySli: unavailableDeliverySli(),
    });
  });

  it("keeps delivery SLI failure and evidence quality visible", () => {
    expect(buildTelegramDeliverySliStatus({ value: null, error: "database unavailable" }))
      .toEqual(unavailableDeliverySli());

    const rollup = {
      evidence: { freshness: "stale" },
      detectionToPlan: { quality: "complete" },
      planToTelegramAcceptance: { quality: "partial" },
      telegramAcceptanceBeforeTtl: { quality: "complete" },
    } as Parameters<typeof buildTelegramDeliverySliStatus>[0]["value"];
    expect(buildTelegramDeliverySliStatus({ value: rollup })).toMatchObject({
      availability: "available",
      quality: "partial",
      freshness: "stale",
      acceptanceDefinition: "telegram_bot_api_accepted_not_user_receipt",
      rollup,
    });
  });
});

// The field contract (shared/types/status/telegram.ts) publishes `null` when the
// weekly `telegram-inactive-cleanup` job has no successful run in the trailing
// 7-day window; a zero count would claim a cleanup that ran and found nobody.
describe("getTelegramBotStats inactive cleanup", () => {
  const NOW = 1_775_890_000;
  const ONE_DAY_SEC = 86_400;

  function insertCleanupRun(
    sqlite: DatabaseSync,
    startedAt: number,
    status: string,
    itemCount: number | null,
  ): void {
    sqlite.prepare(
      `INSERT INTO cron_runs (job, started_at, duration_ms, status, error, item_count, metadata, degraded_reason)
       VALUES (?, ?, 250, ?, ?, ?, ?, ?)`,
    ).run(
      "telegram-inactive-cleanup",
      startedAt,
      status,
      status === "error" ? "weekly cleanup write failed" : null,
      itemCount,
      JSON.stringify(status === "error" ? { reason: "source-failure" } : {}),
      status === "error" ? "source-failure" : null,
    );
  }

  function expectUnavailable(stats: Awaited<ReturnType<typeof getTelegramBotStats>>): void {
    expect(stats.inactiveSubscribersCleanedThisWeek).toBeNull();
    expect(stats.quality?.unavailableFields).toContain("inactiveSubscribersCleanedThisWeek");
    expect(stats.quality?.status).toBe("partial");
  }

  it("publishes null on a fresh deploy where the cleanup has never run", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      expectUnavailable(await getTelegramBotStats(db, NOW));
    } finally {
      sqlite.close();
    }
  });

  it("publishes null when every cleanup attempt in the window failed", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      for (let day = 1; day <= 6; day += 1) {
        insertCleanupRun(sqlite, NOW - day * ONE_DAY_SEC, "error", null);
      }

      expectUnavailable(await getTelegramBotStats(db, NOW));
    } finally {
      sqlite.close();
    }
  });

  it("still sums successful runs in the window, excluding failed attempts", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertCleanupRun(sqlite, NOW - 3 * ONE_DAY_SEC, "ok", 4);
      // The seven-day cache guard records a skip as a successful no-op pass.
      insertCleanupRun(sqlite, NOW - 2 * ONE_DAY_SEC, "ok", 0);
      insertCleanupRun(sqlite, NOW - ONE_DAY_SEC, "error", null);
      // Outside the trailing window.
      insertCleanupRun(sqlite, NOW - 30 * ONE_DAY_SEC, "ok", 9);

      const stats = await getTelegramBotStats(db, NOW);

      expect(stats.inactiveSubscribersCleanedThisWeek).toBe(4);
      expect(stats.quality?.unavailableFields ?? []).not.toContain("inactiveSubscribersCleanedThisWeek");
    } finally {
      sqlite.close();
    }
  });
});

describe("getTelegramBotStats lifecycle availability", () => {
  const NOW_SEC = 1_771_833_600;
  const PENDING_COUNT_SQL = "SELECT COUNT(*) AS pending_count";

  const SUBSCRIBER_AGGREGATE_ROW = {
    total_chats: 40,
    alert_enabled_chats: 32,
    deliverable_chats: 30,
    subscribed_chats: 25,
    empty_alert_chats: 2,
    muted_chats_with_subscriptions: 3,
    dews_chats: 20,
    depeg_chats: 18,
    safety_chats: 12,
    launch_chats: 8,
    reserve_chats: 6,
    freeze_chats: 5,
    all_types_chats: 4,
    total_subscriptions: 55,
    avg_subscriptions_per_subscribed_chat: 2.2,
    last_subscriber_activity_at: NOW_SEC - 120,
    custom_preference_chats: 4,
    quiet_hours_enabled_chats: 6,
    active_preset_followers: 5,
    active_watchers: 40,
    explicit_coin_follows: 55,
    active_dews_opt_ins: 20,
    active_depeg_opt_ins: 18,
    active_safety_opt_ins: 12,
    active_launch_opt_ins: 8,
    active_reserve_opt_ins: 6,
    active_freeze_opt_ins: 5,
    active_all_types_opt_ins: 4,
  };

  const PENDING_CAPACITY_ROW = {
    total: 9,
    expired: 2,
    due: 5,
    deferred: 2,
    near_ttl: 1,
    oldest_pending_created_at: NOW_SEC - 600,
    oldest_due_created_at: NOW_SEC - 540,
    pending_sending: 0,
    pending_execution_unknown: 0,
    sent_cleanup: 0,
    oldest_pending_execution_unknown_at: null,
    fresh_sending: 0,
    fresh_execution_unknown: 0,
    oldest_fresh_execution_unknown_at: null,
    fresh_uncertain_sample_count: 0,
  };

  function failSecondPendingCountRead(inner: MockD1Database): D1Database {
    let pendingCountReads = 0;
    return {
      ...inner,
      prepare(sql: string) {
        const statement = inner.prepare(sql);
        if (!sql.includes(PENDING_COUNT_SQL)) return statement;
        pendingCountReads += 1;
        if (pendingCountReads !== 2) return statement;
        const fail = async () => {
          throw new Error("D1_ERROR: pending delivery count read failed");
        };
        return { ...statement, first: fail, all: fail, run: fail } as D1PreparedStatement;
      },
    } as D1Database;
  }

  function makeTelegramStatusDb(): D1Database {
    const inner = mockD1([
      { match: "FROM telegram_subscribers s", rows: [SUBSCRIBER_AGGREGATE_ROW] },
      { match: PENDING_COUNT_SQL, rows: [{ pending_count: 9 }] },
      { match: "WITH p(now_sec, near_ttl_at, stale_before)", rows: [], first: PENDING_CAPACITY_ROW },
      { match: "WHERE state = 'retry'", rows: [] },
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "FROM cron_runs WHERE job = ?", rows: [], first: { runs: 1, total: 0 } },
      { match: "FROM telegram_watcher_lifecycle_events_daily", rows: [] },
      { match: "SELECT snapshot_at FROM telegram_watcher_lifecycle_daily", rows: [], first: null },
      { match: "WITH recent_jobs AS MATERIALIZED", rows: [], first: null },
      { match: "families LIKE", rows: [], first: null },
      { match: "GROUP BY priority, age_bucket", rows: [] },
      { match: "SUM(COUNT(*)) OVER ()", rows: [] },
      { match: "reason IS NOT NULL OR error_class IS NOT NULL", rows: [] },
      { match: "older_than_15m_count", rows: [], first: null },
      { match: "SUM(attempts) AS total_attempts", rows: [], first: null },
      { match: "AS reason, COUNT(*) AS count", rows: [] },
      { match: "COALESCE(NULLIF(error_class, ''), 'unknown') AS reason", rows: [] },
    ]);
    return failSecondPendingCountRead(inner);
  }

  it("marks a failed lifecycle pending-delivery read unavailable instead of publishing a measured zero", async () => {
    const stats = await getTelegramBotStats(makeTelegramStatusDb(), NOW_SEC);

    // The independent capacity read succeeded and reports a real backlog, so
    // every other optional loader is available and the only missing evidence
    // is the lifecycle snapshot's pending-delivery count.
    expect(stats.pendingDeliveries).toBe(7);
    expect(stats.lifecycleSnapshot?.pendingDeliveries).toBeNull();
    // R1 (unavailable is not zero) and R4 (non-ok names a reason): the failed
    // lifecycle read must name that field instead of publishing a measured zero
    // with `status: "complete"`.
    expect(stats.quality).toEqual({
      status: "partial",
      unavailableFields: ["pendingDeliveries"],
    });
  });
});
