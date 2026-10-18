import { describe, expect, it } from "vitest";
import {
  buildTelegramDeliverySliStatus,
  mapTelegramBotStats,
} from "../status/telegram-bot-stats";
import type { TelegramDeliverySliStatus } from "@shared/types/status";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
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
  it("counts durable pending-table execution-unknown rows and uses the oldest ambiguity", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      sqlite.exec(`
        INSERT INTO telegram_pending_alerts
          (chat_id, message_html, created_at, expires_at, delivery_state, delivery_started_at)
        VALUES ('pending-chat', 'test', 100, 10000, 'execution_unknown', 100);
        INSERT INTO telegram_alert_job_targets
          (job_id, target_key, chat_id, alert_type, pending_dedupe_key, effect_state, created_at)
        VALUES ('stats-job', 'stats-target', 'stats-chat', 'dews', 'stats-key', 'execution_unknown', 200);
      `);
      const snapshot = await loadTelegramPendingCapacity(createSqliteD1(sqlite), 5_001);
      expect(snapshot).toMatchObject({
        pendingExecutionUnknown: 1,
        freshExecutionUnknown: 1,
        executionUnknown: 2,
        oldestExecutionUnknownAgeSec: 4_901,
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
      pendingDisambiguations: { pending_count: "11" },
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
      webhookEffectUnknown: {
        pending_count: "3",
        planned_count: "4",
        started_count: "1",
        execution_unknown_count: "2",
        oldest_planned_at: "1710000040",
        oldest_ambiguous_at: "1710000010",
        sample_count: "7",
      },
      retryErrorClasses: [
        { error_class: "rate_limit", pending_count: "4" },
        { error_class: "server_error", pending_count: "2" },
      ],
      recapTelemetry: {
        enabled_private_chats: "14",
        due_count: "3",
        queued_count: "5",
        execution_unknown_count: "1",
        oldest_due_at: "1710000040",
        oldest_queued_at: "1710000020",
        oldest_execution_unknown_at: "1710000010",
      },
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
      pendingDisambiguations: 11,
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
      webhookEffectUnknown: 3,
      webhookEffectLifecycle: {
        planned: 4,
        started: 1,
        executionUnknown: 2,
        oldestPlannedAgeSec: 60,
        oldestAmbiguousAgeSec: 90,
        sampleLimit: 5001,
        lowerBound: false,
      },
      personalizedRecap: {
        enabledPrivateChats: 14,
        due: 3,
        queued: 5,
        executionUnknown: 1,
        oldestDueAgeSec: 60,
        oldestQueuedAgeSec: 80,
        oldestExecutionUnknownAgeSec: 90,
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
      pendingDisambiguations: null,
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

