import { baseState } from "./mini-app-test-fixtures";
import type { TelegramMiniAppState } from "./types";

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
