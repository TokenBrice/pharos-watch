import type { TelegramPulse } from "@shared/types/status";
import type { MockTableConfig } from "@shared/test-utils/mock-d1";

const aggregateDefaults = {
  active_watchers: 12, new_watchers: 0, explicit_coin_follows: 12, active_preset_followers: 0,
  active_dews_opt_ins: 12, active_depeg_opt_ins: 8, active_safety_opt_ins: 7,
  active_launch_opt_ins: 6, active_all_types_opt_ins: 6, quiet_hours_enabled_chats: 0,
};

export function pulseAggregate(overrides: Partial<typeof aggregateDefaults> = {}) {
  return { ...aggregateDefaults, ...overrides };
}

export function cachedPulse(updatedAt: number, overrides: Partial<TelegramPulse> = {}): TelegramPulse {
  return {
    activeWatchers: 8, coinSubscriptions: 13, explicitCoinSubscriptions: 10,
    presetImpliedCoinSubscriptions: 3, activePresetFollowers: 2, newWatchersToday: 5,
    churnedWatchersToday: 0, reactivatedWatchersToday: 0, historySource: "live-fallback",
    topCoins: ["USDC"], pendingDeliveries: 5, miniAppSessionsToday: 7, miniAppMutationsToday: 6,
    miniAppDeniedToday: 2, miniAppReplayClaimsToday: 1, miniAppOpenToFirstMutationP50Sec: null,
    currentSnapshotAt: updatedAt, lifecycleHistoryUpdatedAt: updatedAt, lifecycleHistoryEverySeconds: 900,
    quality: { status: "complete", unavailableFields: [] },
    privacy: { exactActiveWatchers: true, lowCardinalityThreshold: 5, suppressedFields: [] },
    updatedAt, updatedEverySeconds: 300, watcherHistory: [], ...overrides,
  };
}

export function pulseCacheTables(pulse: TelegramPulse, heavyUpdatedAt: number): MockTableConfig[] {
  return [
    { match: "FROM cache WHERE key = ?", matchBinds: ["telegram:pulse:snapshot"], rows: [
      { key: "telegram:pulse:snapshot", value: JSON.stringify(pulse), updated_at: pulse.updatedAt },
    ] },
    { match: "FROM cache WHERE key = ?", matchBinds: ["telegram:pulse:heavy-sections-updated-at"], rows: [
      { key: "telegram:pulse:heavy-sections-updated-at", value: String(heavyUpdatedAt), updated_at: heavyUpdatedAt },
    ] },
  ];
}
