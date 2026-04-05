import { describe, expect, it } from "vitest";
import { mapTelegramBotStats } from "../status/telegram-bot-stats";

describe("mapTelegramBotStats", () => {
  it("coerces aggregate rows into the public Telegram status shape", () => {
    const result = mapTelegramBotStats({
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
        all_types_chats: "4",
        total_subscriptions: "30",
        avg_subscriptions_per_subscribed_chat: "3.46",
        last_subscriber_activity_at: "1710000000",
        custom_preference_chats: "3",
        quiet_hours_enabled_chats: "2",
      },
      pendingDisambiguations: { pending_count: "11" },
      pendingDeliveries: { pending_count: "12" },
      topStablecoins: [
        { stablecoin_id: "usdc-circle", subscribers: "5" },
        { stablecoin_id: "unknown-stablecoin", subscribers: "2" },
      ],
    });

    expect(result).toEqual({
      totalChats: 12,
      alertEnabledChats: 10,
      deliverableChats: 9,
      subscribedChats: 8,
      emptyAlertChats: 1,
      mutedChatsWithSubscriptions: 2,
      totalSubscriptions: 30,
      avgSubscriptionsPerSubscribedChat: 3.5,
      pendingDisambiguations: 11,
      pendingDeliveries: 12,
      lastSubscriberActivityAt: 1710000000,
      customPreferenceChats: 3,
      quietHoursEnabledChats: 2,
      alertTypeChats: {
        dews: 7,
        depeg: 6,
        safety: 5,
        allTypes: 4,
      },
      topStablecoins: [
        { stablecoinId: "usdc-circle", symbol: "USDC", subscribers: 5 },
        { stablecoinId: "unknown-stablecoin", symbol: "unknown-stablecoin", subscribers: 2 },
      ],
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
        all_types_chats: null,
        total_subscriptions: null,
        avg_subscriptions_per_subscribed_chat: "bad",
        last_subscriber_activity_at: "bad",
        custom_preference_chats: null,
        quiet_hours_enabled_chats: null,
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
      avgSubscriptionsPerSubscribedChat: 0,
      pendingDisambiguations: 0,
      pendingDeliveries: 0,
      lastSubscriberActivityAt: null,
      customPreferenceChats: 0,
      quietHoursEnabledChats: 0,
      alertTypeChats: {
        dews: 0,
        depeg: 0,
        safety: 0,
        allTypes: 0,
      },
      topStablecoins: [{ stablecoinId: "usdt-tether", symbol: "USDT", subscribers: 0 }],
    });
  });
});
