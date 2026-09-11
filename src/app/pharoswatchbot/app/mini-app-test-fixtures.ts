import type { SubscribedCoin, TelegramMiniAppState } from "./types";

export function makeSubscribedCoin(
  alertTypes: Partial<SubscribedCoin["alertTypes"]>,
  alertOverrides: Partial<NonNullable<SubscribedCoin["alertOverrides"]>> = {},
): SubscribedCoin {
  return {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    alertTypes: { dews: false, depeg: false, safety: false, launch: false, reserve: false, freeze: false, ...alertTypes },
    alertOverrides: { dews: false, depeg: false, safety: false, launch: false, reserve: false, freeze: false, ...alertOverrides },
    dewsMinBand: null,
    depegStepBps: null,
    safetyMode: null,
    snoozeUntilTs: null,
  };
}

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

interface StateOverrides {
  viewer?: Partial<TelegramMiniAppState["viewer"]>;
  subscriber?: Partial<Omit<TelegramMiniAppState["subscriber"], "globalAlerts" | "quietHours" | "recap">> & {
    globalAlerts?: Partial<TelegramMiniAppState["subscriber"]["globalAlerts"]>;
    quietHours?: Partial<TelegramMiniAppState["subscriber"]["quietHours"]>;
    recap?: Partial<TelegramMiniAppState["subscriber"]["recap"]>;
  };
  presets?: TelegramMiniAppState["presets"];
  subscriptions?: TelegramMiniAppState["subscriptions"];
  catalog?: TelegramMiniAppState["catalog"];
  health?: Partial<TelegramMiniAppState["health"]>;
}

/**
 * Derives a session state from the shared `baseState` with explicit scenario
 * overrides. Every call returns fresh nested objects, so a test mutating its
 * state cannot leak into the base fixture or sibling tests.
 */
export function makeMiniAppState(overrides: StateOverrides = {}): TelegramMiniAppState {
  const { viewer, subscriber, presets, subscriptions, catalog, health } = overrides;
  const { globalAlerts, quietHours, recap, ...subscriberRest } = subscriber ?? {};
  return {
    ...baseState,
    viewer: { ...baseState.viewer, ...viewer },
    subscriber: {
      ...baseState.subscriber,
      ...subscriberRest,
      globalAlerts: { ...baseState.subscriber.globalAlerts, ...globalAlerts },
      quietHours: { ...baseState.subscriber.quietHours, ...quietHours },
      recap: { ...baseState.subscriber.recap, ...recap },
    },
    presets: presets ?? baseState.presets,
    subscriptions: subscriptions ?? baseState.subscriptions,
    catalog: catalog ?? baseState.catalog,
    health: { ...baseState.health, ...health },
  };
}
