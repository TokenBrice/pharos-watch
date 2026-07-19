import type { TelegramAlertType } from "@shared/types/status";
import type { SubscriberRow } from "./dispatch-telegram-routing";
import type { PendingCapacitySnapshot } from "./telegram-pending";

type LegacyFanoutAlertType = Exclude<TelegramAlertType, "freeze">;

interface FanoutSubscriberLoadOptions {
  chatIds?: readonly string[];
  onLoaderTiming?: (family: FanoutLoaderFamily, durationMs: number) => void;
}

export type FanoutLoaderFamily =
  | "direct"
  | "preset"
  | "global"
  | "snooze-explicit-off";

export interface AlertStablecoinIds {
  dewsIds: string[];
  depegIds: string[];
  safetyIds: string[];
  launchIds: string[];
  reserveIds: string[];
}

export type PresetSubscriberLoadResult =
  | { kind: "ok"; rows: Map<string, SubscriberRow[]> }
  | {
      kind: "partial";
      rows: Map<string, SubscriberRow[]>;
      queryFailures: number;
      resolutionFailures: number;
    }
  | { kind: "query-failed"; error: unknown }
  | { kind: "resolution-failed" };

export interface FanoutSubscriptionInputs {
  directDewsSubs: Map<string, SubscriberRow[]>;
  directDepegSubs: Map<string, SubscriberRow[]>;
  directSafetySubs: Map<string, SubscriberRow[]>;
  launchSubs: Map<string, SubscriberRow[]>;
  reserveSubs: Map<string, SubscriberRow[]>;
  presetDewsResult: PresetSubscriberLoadResult;
  presetDepegResult: PresetSubscriberLoadResult;
  presetSafetyResult: PresetSubscriberLoadResult;
  globalDewsSubs: SubscriberRow[];
  globalDepegSubs: SubscriberRow[];
  globalSafetySubs: SubscriberRow[];
  globalLaunchSubs: SubscriberRow[];
  globalReserveSubs: SubscriberRow[];
  perCoinSnoozeMap: Map<string, Set<string>>;
  perCoinExplicitlyOffMaps: Record<LegacyFanoutAlertType, Map<string, Set<string>>>;
}

interface FanoutSubscriptionLoaders {
  loadSubscriberRowsBatch: (
    db: D1Database,
    stablecoinIds: string[],
    type: LegacyFanoutAlertType,
    nowSec: number,
    options?: FanoutSubscriberLoadOptions,
  ) => Promise<Map<string, SubscriberRow[]>>;
  loadPresetSubscriberRowsBatch: (
    db: D1Database,
    stablecoinIds: string[],
    type: Exclude<LegacyFanoutAlertType, "launch" | "reserve">,
    nowSec: number,
  ) => Promise<PresetSubscriberLoadResult>;
  loadGlobalSubscriberRows: (
    db: D1Database,
    type: LegacyFanoutAlertType,
    nowSec: number,
    options?: FanoutSubscriberLoadOptions,
  ) => Promise<SubscriberRow[]>;
  loadPerCoinSnoozeMap: (
    db: D1Database,
    stablecoinIds: readonly string[],
    nowSec: number,
    options?: FanoutSubscriberLoadOptions,
  ) => Promise<Map<string, Set<string>>>;
  loadPerCoinExplicitlyOffMap: (
    db: D1Database,
    stablecoinIds: readonly string[],
    type: LegacyFanoutAlertType,
    options?: FanoutSubscriberLoadOptions,
  ) => Promise<Map<string, Set<string>>>;
}

export interface PendingCapacityFields {
  pendingTotal: number;
  pendingDue: number;
  pendingDeferredCount: number;
  pendingExpiredCount: number;
  pendingNearTtlCount: number;
  oldestPendingAgeSec: number | null;
  oldestDuePendingAgeSec: number | null;
  estimatedDrainTimeSec: number;
  pendingDrainBudgetPerRun: number;
}

export function pendingCapacityFields(capacity: PendingCapacitySnapshot): PendingCapacityFields {
  return {
    pendingTotal: capacity.active,
    pendingDue: capacity.due,
    pendingDeferredCount: capacity.deferred,
    pendingExpiredCount: capacity.expired,
    pendingNearTtlCount: capacity.nearTtl,
    oldestPendingAgeSec: capacity.oldestPendingAgeSec,
    oldestDuePendingAgeSec: capacity.oldestDuePendingAgeSec,
    estimatedDrainTimeSec: capacity.estimatedDrainTimeSec,
    pendingDrainBudgetPerRun: capacity.drainBudgetPerRun,
  };
}

export async function loadFanoutSubscriptionInputs(
  db: D1Database,
  ids: AlertStablecoinIds,
  loaders: FanoutSubscriptionLoaders,
  nowSec: number,
  options: FanoutSubscriberLoadOptions = {},
): Promise<FanoutSubscriptionInputs> {
  const {
    dewsIds,
    depegIds,
    safetyIds,
    launchIds,
    reserveIds,
  } = ids;
  const timed = async <T>(family: FanoutLoaderFamily, load: () => Promise<T>): Promise<T> => {
    const startedAtMs = Date.now();
    try {
      return await load();
    } finally {
      options.onLoaderTiming?.(family, Math.max(0, Date.now() - startedAtMs));
    }
  };
  const emptyPresetResult = (): PresetSubscriberLoadResult => ({ kind: "ok", rows: new Map() });
  const allStablecoinIds = [...dewsIds, ...depegIds, ...safetyIds, ...launchIds, ...reserveIds];
  const [
    directDewsSubs,
    directDepegSubs,
    directSafetySubs,
    launchSubs,
    reserveSubs,
    presetDewsResult,
    presetDepegResult,
    presetSafetyResult,
    globalDewsSubs,
    globalDepegSubs,
    globalSafetySubs,
    globalLaunchSubs,
    globalReserveSubs,
    perCoinSnoozeMap,
    perCoinDewsExplicitlyOffMap,
    perCoinDepegExplicitlyOffMap,
    perCoinSafetyExplicitlyOffMap,
    perCoinLaunchExplicitlyOffMap,
    perCoinReserveExplicitlyOffMap,
  ] = await Promise.all([
    dewsIds.length > 0
      ? timed("direct", () => loaders.loadSubscriberRowsBatch(db, dewsIds, "dews", nowSec, options))
      : new Map(),
    depegIds.length > 0
      ? timed("direct", () => loaders.loadSubscriberRowsBatch(db, depegIds, "depeg", nowSec, options))
      : new Map(),
    safetyIds.length > 0
      ? timed("direct", () => loaders.loadSubscriberRowsBatch(db, safetyIds, "safety", nowSec, options))
      : new Map(),
    launchIds.length > 0
      ? timed("direct", () => loaders.loadSubscriberRowsBatch(db, launchIds, "launch", nowSec, options))
      : new Map(),
    reserveIds.length > 0
      ? timed("direct", () => loaders.loadSubscriberRowsBatch(db, reserveIds, "reserve", nowSec, options))
      : new Map(),
    dewsIds.length > 0
      ? timed("preset", () => loaders.loadPresetSubscriberRowsBatch(db, dewsIds, "dews", nowSec))
      : emptyPresetResult(),
    depegIds.length > 0
      ? timed("preset", () => loaders.loadPresetSubscriberRowsBatch(db, depegIds, "depeg", nowSec))
      : emptyPresetResult(),
    safetyIds.length > 0
      ? timed("preset", () => loaders.loadPresetSubscriberRowsBatch(db, safetyIds, "safety", nowSec))
      : emptyPresetResult(),
    dewsIds.length > 0
      ? timed("global", () => loaders.loadGlobalSubscriberRows(db, "dews", nowSec, options))
      : [],
    depegIds.length > 0
      ? timed("global", () => loaders.loadGlobalSubscriberRows(db, "depeg", nowSec, options))
      : [],
    safetyIds.length > 0
      ? timed("global", () => loaders.loadGlobalSubscriberRows(db, "safety", nowSec, options))
      : [],
    launchIds.length > 0
      ? timed("global", () => loaders.loadGlobalSubscriberRows(db, "launch", nowSec, options))
      : [],
    reserveIds.length > 0
      ? timed("global", () => loaders.loadGlobalSubscriberRows(db, "reserve", nowSec, options))
      : [],
    allStablecoinIds.length > 0
      ? timed("snooze-explicit-off", () =>
        loaders.loadPerCoinSnoozeMap(db, allStablecoinIds, nowSec, options))
      : new Map(),
    dewsIds.length > 0
      ? timed("snooze-explicit-off", () => loaders.loadPerCoinExplicitlyOffMap(db, dewsIds, "dews", options))
      : new Map(),
    depegIds.length > 0
      ? timed("snooze-explicit-off", () => loaders.loadPerCoinExplicitlyOffMap(db, depegIds, "depeg", options))
      : new Map(),
    safetyIds.length > 0
      ? timed("snooze-explicit-off", () => loaders.loadPerCoinExplicitlyOffMap(db, safetyIds, "safety", options))
      : new Map(),
    launchIds.length > 0
      ? timed("snooze-explicit-off", () => loaders.loadPerCoinExplicitlyOffMap(db, launchIds, "launch", options))
      : new Map(),
    reserveIds.length > 0
      ? timed("snooze-explicit-off", () => loaders.loadPerCoinExplicitlyOffMap(db, reserveIds, "reserve", options))
      : new Map(),
  ]);

  return {
    directDewsSubs,
    directDepegSubs,
    directSafetySubs,
    launchSubs,
    reserveSubs,
    presetDewsResult,
    presetDepegResult,
    presetSafetyResult,
    globalDewsSubs,
    globalDepegSubs,
    globalSafetySubs,
    globalLaunchSubs,
    globalReserveSubs,
    perCoinSnoozeMap,
    perCoinExplicitlyOffMaps: {
      dews: perCoinDewsExplicitlyOffMap,
      depeg: perCoinDepegExplicitlyOffMap,
      safety: perCoinSafetyExplicitlyOffMap,
      launch: perCoinLaunchExplicitlyOffMap,
      reserve: perCoinReserveExplicitlyOffMap,
    },
  };
}
