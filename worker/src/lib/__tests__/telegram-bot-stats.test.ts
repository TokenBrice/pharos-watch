import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  getTelegramBotStats,
  loadTelegramMiniAppDailyAggregate,
  mapTelegramBotStats,
} from "../status/telegram-bot-stats";

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
        all_types_chats: "4",
        total_subscriptions: "30",
        avg_subscriptions_per_subscribed_chat: "3.46",
        last_subscriber_activity_at: "1710000000",
        custom_preference_chats: "3",
        quiet_hours_enabled_chats: "2",
        active_preset_followers: "2",
      },
      pendingDisambiguations: { pending_count: "11" },
      pendingDeliveries: { pending_count: "12" },
      pendingDeliveryTelemetry: {
        pending_count: "12",
        oldest_created_at: "1710000040",
        oldest_due_created_at: "1710000070",
        due_count: "8",
        deferred_count: "3",
        expired_count: "1",
        near_ttl_count: "2",
        execution_unknown_count: "2",
        completed_cleanup_count: "1",
      },
      webhookEffectUnknown: { pending_count: "3" },
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
          allTypes: 4,
        },
        quietHoursEnabledChats: 2,
        pendingDeliveries: 12,
      },
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
      pendingDisambiguations: 11,
      pendingDeliveries: 12,
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
        due: 8,
        deferred: 3,
        expired: 1,
        nearTtl: 2,
        executionUnknown: 2,
        completedPendingCleanup: 1,
      },
      webhookEffectUnknown: 3,
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
        all_types_chats: null,
        total_subscriptions: null,
        avg_subscriptions_per_subscribed_chat: "bad",
        last_subscriber_activity_at: "bad",
        custom_preference_chats: null,
        quiet_hours_enabled_chats: null,
        active_preset_followers: null,
      },
      pendingDisambiguations: null,
      pendingDeliveries: { pending_count: "bad" },
      topStablecoins: [{ stablecoin_id: "usdt-tether", subscribers: "bad" }],
    });

    expect(result).toEqual({
      totalChats: 0,
      alertEnabledChats: 0,
      deliverableChats: 0,
      subscribedChats: 0,
      emptyAlertChats: 0,
      mutedChatsWithSubscriptions: 0,
      totalSubscriptions: 0,
      explicitCoinSubscriptions: 0,
      presetImpliedCoinSubscriptions: 0,
      activePresetFollowers: 0,
      avgSubscriptionsPerSubscribedChat: 0,
      pendingDisambiguations: 0,
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
    });
  });
});

describe("getTelegramBotStats", () => {
  it("queries launch-aware aggregates and active top-coin rows", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_subscribers s",
        first: {
          total_chats: 3,
          alert_enabled_chats: 2,
          deliverable_chats: 2,
          subscribed_chats: 2,
          empty_alert_chats: 0,
          muted_chats_with_subscriptions: 0,
          dews_chats: 1,
          depeg_chats: 1,
          safety_chats: 0,
          launch_chats: 1,
          all_types_chats: 0,
          total_subscriptions: 2,
          avg_subscriptions_per_subscribed_chat: 1,
          last_subscriber_activity_at: 1_710_000_000,
          custom_preference_chats: 0,
          quiet_hours_enabled_chats: 0,
        },
        rows: [],
      },
      { match: "FROM telegram_pending_disambiguation", first: { pending_count: 1 }, rows: [] },
      {
        match: "oldest_due_created_at",
        first: {
          pending_count: 2,
          oldest_created_at: 1_710_000_040,
          oldest_due_created_at: 1_710_000_070,
          due_count: 1,
          deferred_count: 1,
          expired_count: 0,
          near_ttl_count: 0,
          execution_unknown_count: 0,
          completed_cleanup_count: 0,
        },
        rows: [],
      },
      { match: "FROM telegram_processed_updates", first: { pending_count: 1 }, rows: [] },
      {
        match: "last_error_class AS error_class",
        rows: [{ error_class: "rate_limit", pending_count: 1 }],
      },
      { match: "SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts", first: { pending_count: 2 }, rows: [] },
      { match: "FROM telegram_subscriptions", rows: [{ stablecoin_id: "usdpt-western-union", subscribers: 2 }] },
    ]);

    const result = await getTelegramBotStats(db, 1_710_000_100);

    const history = db.getHistory();
    const aggregateQuery = history.find((entry) => entry.sql.includes("FROM telegram_subscribers s"));
    const topCoinsQuery = history.find(
      (entry) => entry.sql.includes("FROM telegram_subscriptions") && entry.sql.includes("GROUP BY stablecoin_id"),
    );

    expect(aggregateQuery?.sql).toContain("global_alert_launch");
    expect(aggregateQuery?.sql).toContain("alert_launch");
    expect(topCoinsQuery?.sql).toContain("alert_launch = 1");
    expect(history.some((entry) => entry.sql.includes("FROM telegram_usage_daily"))).toBe(false);
    expect(result.alertTypeChats.launch).toBe(1);
    expect(result.oldestPendingDeliveryAgeSec).toBe(60);
    expect(result.oldestDuePendingAgeSec).toBe(30);
    expect(result.estimatedDrainTimeSec).toBe(300);
    expect(result.pendingDeliveryBacklog).toEqual({
      due: 1,
      deferred: 1,
      expired: 0,
      nearTtl: 0,
      executionUnknown: 0,
      completedPendingCleanup: 0,
    });
    expect(result.webhookEffectUnknown).toBe(1);
    expect(result.retryErrorClassCounts).toEqual({ rate_limit: 1 });
    expect(result.topStablecoins[0]).toEqual({
      stablecoinId: "usdpt-western-union",
      symbol: "USDPT",
      subscribers: 2,
      explicitSubscribers: 2,
      presetImpliedSubscribers: 0,
    });
    expect(result.presetQueryFailures).toBeUndefined();
  });

  it("sums telegram-inactive-cleanup item_count over the trailing 7-day window", async () => {
    // The cron runs daily but only performs real deletes on roughly one of
    // every seven days. Three rows in the window with item_counts 0/37/0 must
    // surface as 37, not the latest row's 0.
    const now = 1_710_000_100;
    const db = mockD1([
      {
        match: "FROM telegram_subscribers s",
        first: {
          total_chats: 1,
          alert_enabled_chats: 1,
          deliverable_chats: 1,
          subscribed_chats: 1,
          empty_alert_chats: 0,
          muted_chats_with_subscriptions: 0,
          dews_chats: 1,
          depeg_chats: 0,
          safety_chats: 0,
          launch_chats: 0,
          all_types_chats: 0,
          total_subscriptions: 1,
          avg_subscriptions_per_subscribed_chat: 1,
          last_subscriber_activity_at: 1_710_000_000,
          custom_preference_chats: 0,
          quiet_hours_enabled_chats: 0,
        },
        rows: [],
      },
      { match: "FROM telegram_pending_disambiguation", first: { pending_count: 0 }, rows: [] },
      {
        match: "MIN(created_at) AS oldest_created_at",
        first: { pending_count: 0, oldest_created_at: null, due_count: 0, deferred_count: 0, expired_count: 0 },
        rows: [],
      },
      { match: "last_error_class AS error_class", rows: [] },
      { match: "SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts", first: { pending_count: 0 }, rows: [] },
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [] },
      {
        match: "SUM(item_count)",
        matchBinds: ["telegram-inactive-cleanup", now - 7 * 24 * 60 * 60],
        first: { total: 37 },
        rows: [],
      },
    ]);

    const result = await getTelegramBotStats(db, now);

    const history = db.getHistory();
    const inactiveQuery = history.find((entry) => entry.sql.includes("SUM(item_count)"));
    expect(inactiveQuery?.sql).toContain("FROM cron_runs");
    expect(inactiveQuery?.sql).toContain("status = 'ok'");
    expect(result.inactiveSubscribersCleanedThisWeek).toBe(37);
  });

  it("reports 0 inactive cleanup when no run is present in the trailing 7-day window", async () => {
    // COALESCE(SUM(item_count), 0) returns 0 when the window holds no rows.
    const now = 1_710_000_100;
    const db = mockD1([
      {
        match: "FROM telegram_subscribers s",
        first: {
          total_chats: 1,
          alert_enabled_chats: 1,
          deliverable_chats: 1,
          subscribed_chats: 1,
          empty_alert_chats: 0,
          muted_chats_with_subscriptions: 0,
          dews_chats: 1,
          depeg_chats: 0,
          safety_chats: 0,
          launch_chats: 0,
          all_types_chats: 0,
          total_subscriptions: 1,
          avg_subscriptions_per_subscribed_chat: 1,
          last_subscriber_activity_at: 1_710_000_000,
          custom_preference_chats: 0,
          quiet_hours_enabled_chats: 0,
        },
        rows: [],
      },
      { match: "FROM telegram_pending_disambiguation", first: { pending_count: 0 }, rows: [] },
      {
        match: "MIN(created_at) AS oldest_created_at",
        first: { pending_count: 0, oldest_created_at: null, due_count: 0, deferred_count: 0, expired_count: 0 },
        rows: [],
      },
      { match: "last_error_class AS error_class", rows: [] },
      { match: "SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts", first: { pending_count: 0 }, rows: [] },
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [] },
      {
        match: "SUM(item_count)",
        matchBinds: ["telegram-inactive-cleanup", now - 7 * 24 * 60 * 60],
        first: { total: 0 },
        rows: [],
      },
    ]);

    const result = await getTelegramBotStats(db, now);

    expect(result.inactiveSubscribersCleanedThisWeek).toBe(0);
  });

  it("surfaces a positive preset-query failure counter", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_subscribers s",
        first: {
          total_chats: 1,
          alert_enabled_chats: 1,
          deliverable_chats: 1,
          subscribed_chats: 1,
          empty_alert_chats: 0,
          muted_chats_with_subscriptions: 0,
          dews_chats: 1,
          depeg_chats: 0,
          safety_chats: 0,
          launch_chats: 0,
          all_types_chats: 0,
          total_subscriptions: 1,
          avg_subscriptions_per_subscribed_chat: 1,
          last_subscriber_activity_at: 1_710_000_000,
          custom_preference_chats: 0,
          quiet_hours_enabled_chats: 0,
        },
        rows: [],
      },
      { match: "FROM telegram_pending_disambiguation", first: { pending_count: 0 }, rows: [] },
      {
        match: "MIN(created_at) AS oldest_created_at",
        first: { pending_count: 0, oldest_created_at: null, due_count: 0, deferred_count: 0, expired_count: 0 },
        rows: [],
      },
      { match: "last_error_class AS error_class", rows: [] },
      { match: "SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts", first: { pending_count: 0 }, rows: [] },
      { match: "FROM telegram_subscriptions", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["telegram:preset-query-failure-count"],
        first: { value: "3" },
        rows: [],
      },
    ]);

    const result = await getTelegramBotStats(db, 1_710_000_100);

    expect(result.presetQueryFailures).toBe(3);
  });
});

describe("loadTelegramMiniAppDailyAggregate", () => {
  it("counts successful snooze, timezone_change, and unsubscribe events as mutations (not denials)", async () => {
    // The success-event tuple must cover every event type emitted by
    // `mutationEventType` in worker/src/api/telegram-mini-app.ts. Otherwise the
    // operator gauge undercounts mutation traffic. Bind order is asserted
    // explicitly so any future drift surfaces here.
    const day = "2026-05-14";
    const db = mockD1([
      {
        match: "FROM telegram_usage_daily",
        matchBinds: [
          "mini_app_mutation",
          "mini_app_recommended_setup",
          "mini_app_coin_add",
          "mini_app_coin_remove",
          "mini_app_quiet_hours",
          "mini_app_snooze",
          "mini_app_coin_snooze",
          "mini_app_forget",
          "timezone_change",
          "unsubscribe",
          "startapp",
          "menu_or_main_app",
          day,
        ],
        first: {
          mini_app_sessions: 4,
          mini_app_mutations: 9,
          mini_app_denied: 0,
          mini_app_replay_claimed: 0,
        },
        rows: [],
      },
    ]);

    const aggregate = await loadTelegramMiniAppDailyAggregate(db, day);

    const history = db.getHistory();
    const aggregateSql = history.find((entry) => entry.sql.includes("FROM telegram_usage_daily"));
    expect(aggregateSql?.sql).toContain("event_type IN (?, ?, ?, ?, ?, ?, ?, ?)");
    expect(aggregateSql?.binds).toEqual([
      "mini_app_mutation",
      "mini_app_recommended_setup",
      "mini_app_coin_add",
      "mini_app_coin_remove",
      "mini_app_quiet_hours",
      "mini_app_snooze",
      "mini_app_coin_snooze",
      "mini_app_forget",
      "timezone_change",
      "unsubscribe",
      "startapp",
      "menu_or_main_app",
      day,
    ]);
    expect(aggregate.mutations).toBe(9);
    expect(aggregate.denied).toBe(0);
    expect(aggregate.sessions).toBe(4);
    expect(aggregate.replayClaimed).toBe(0);
  });

  it("filters shared success event types to Mini App source categories", async () => {
    const day = "2026-05-14";
    const db = mockD1([
      {
        match: "FROM telegram_usage_daily",
        matchBinds: [
          "mini_app_mutation",
          "mini_app_recommended_setup",
          "mini_app_coin_add",
          "mini_app_coin_remove",
          "mini_app_quiet_hours",
          "mini_app_snooze",
          "mini_app_coin_snooze",
          "mini_app_forget",
          "timezone_change",
          "unsubscribe",
          "startapp",
          "menu_or_main_app",
          day,
        ],
        first: {
          mini_app_sessions: 0,
          mini_app_mutations: 1,
          mini_app_denied: 0,
          mini_app_replay_claimed: 0,
        },
        rows: [],
      },
    ]);

    const aggregate = await loadTelegramMiniAppDailyAggregate(db, day);

    const aggregateSql = db.getHistory().find((entry) => entry.sql.includes("FROM telegram_usage_daily"));
    expect(aggregateSql?.sql).toContain("source_category IN (?, ?)");
    expect(aggregate.mutations).toBe(1);
  });
});
