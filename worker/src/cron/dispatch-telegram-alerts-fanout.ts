import type { TelegramAlertType } from "@shared/types/status";
import type { SubscriberRow } from "./dispatch-telegram-routing";
import type { PendingCapacitySnapshot } from "./telegram-pending";

type LegacyFanoutAlertType = Exclude<TelegramAlertType, "freeze">;

interface FanoutSubscriberLoadOptions {
  chatIds?: readonly string[];
}

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
    loaders.loadSubscriberRowsBatch(db, dewsIds, "dews", nowSec, options),
    loaders.loadSubscriberRowsBatch(db, depegIds, "depeg", nowSec, options),
    loaders.loadSubscriberRowsBatch(db, safetyIds, "safety", nowSec, options),
    loaders.loadSubscriberRowsBatch(db, launchIds, "launch", nowSec, options),
    loaders.loadSubscriberRowsBatch(db, reserveIds, "reserve", nowSec, options),
    loaders.loadPresetSubscriberRowsBatch(db, dewsIds, "dews", nowSec),
    loaders.loadPresetSubscriberRowsBatch(db, depegIds, "depeg", nowSec),
    loaders.loadPresetSubscriberRowsBatch(db, safetyIds, "safety", nowSec),
    loaders.loadGlobalSubscriberRows(db, "dews", nowSec, options),
    loaders.loadGlobalSubscriberRows(db, "depeg", nowSec, options),
    loaders.loadGlobalSubscriberRows(db, "safety", nowSec, options),
    loaders.loadGlobalSubscriberRows(db, "launch", nowSec, options),
    loaders.loadGlobalSubscriberRows(db, "reserve", nowSec, options),
    loaders.loadPerCoinSnoozeMap(db, [...dewsIds, ...depegIds, ...safetyIds, ...launchIds, ...reserveIds], nowSec, options),
    loaders.loadPerCoinExplicitlyOffMap(db, dewsIds, "dews", options),
    loaders.loadPerCoinExplicitlyOffMap(db, depegIds, "depeg", options),
    loaders.loadPerCoinExplicitlyOffMap(db, safetyIds, "safety", options),
    loaders.loadPerCoinExplicitlyOffMap(db, launchIds, "launch", options),
    loaders.loadPerCoinExplicitlyOffMap(db, reserveIds, "reserve", options),
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
