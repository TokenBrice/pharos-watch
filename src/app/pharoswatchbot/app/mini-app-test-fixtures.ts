import type { TelegramMiniAppState } from "./types";

export const baseState: TelegramMiniAppState = {
  viewer: { userId: "42", username: "watcher", chatId: "42", chatType: "private", canMutate: true, mutationBlockReason: null },
  subscriber: {
    exists: true,
    globalAlerts: { dews: true, depeg: true, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: 250 },
    quietHours: { enabled: false, startHourUtc: null, endHourUtc: null, timezone: "UTC" },
    recap: { available: true, enabled: false, deliveryHourLocal: 9, timezoneConfirmed: true, nextDueAt: null, lastWindowEndAt: null, lastDeliveredLocalDate: null, lastOutcome: null },
    snoozeUntilTs: null,
  },
  presets: [],
  subscriptions: [
    { stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin", alertTypes: { dews: true, depeg: true, safety: false, launch: false, reserve: false, freeze: false }, dewsMinBand: "ALERT", depegStepBps: 250, safetyMode: null, snoozeUntilTs: null },
  ],
  catalog: {
    recommendedPresets: [{ id: "usd-top25", label: "USD Top 25" }],
    searchableCoins: [{ stablecoinId: "usdt-tether", symbol: "USDT", name: "Tether", peg: "USD" }],
  },
  health: { lastSuccessfulDeliveryAt: 1_700_000_000, lastSuccessfulReplyAt: 1_700_000_100, queuedAlerts: 0, recentFailureClass: null },
};
