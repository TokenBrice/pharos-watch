import type { TelegramAlertType } from "@shared/types/status";
import type { SubscriberRow } from "./dispatch-telegram-routing";
import type { PendingCapacitySnapshot } from "./telegram-pending";

export interface AlertStablecoinIds {
  dewsIds: string[];
  depegIds: string[];
  safetyIds: string[];
  launchIds: string[];
}

export type PresetSubscriberLoadResult =
  | { kind: "ok"; rows: Map<string, SubscriberRow[]> }
  | { kind: "query-failed"; error: unknown }
  | { kind: "resolution-failed" };

export interface FanoutSubscriptionInputs {
  directDewsSubs: Map<string, SubscriberRow[]>;
  directDepegSubs: Map<string, SubscriberRow[]>;
  directSafetySubs: Map<string, SubscriberRow[]>;
  launchSubs: Map<string, SubscriberRow[]>;
  presetDewsResult: PresetSubscriberLoadResult;
  presetDepegResult: PresetSubscriberLoadResult;
  presetSafetyResult: PresetSubscriberLoadResult;
  globalDewsSubs: SubscriberRow[];
  globalDepegSubs: SubscriberRow[];
  globalSafetySubs: SubscriberRow[];
  globalLaunchSubs: SubscriberRow[];
  perCoinSnoozeMap: Map<string, Set<string>>;
}

interface FanoutSubscriptionLoaders {
  loadSubscriberRowsBatch: (
    db: D1Database,
    stablecoinIds: string[],
    type: TelegramAlertType,
    nowSec: number,
  ) => Promise<Map<string, SubscriberRow[]>>;
  loadPresetSubscriberRowsBatch: (
    db: D1Database,
    stablecoinIds: string[],
    type: Exclude<TelegramAlertType, "launch">,
    nowSec: number,
  ) => Promise<PresetSubscriberLoadResult>;
  loadGlobalSubscriberRows: (db: D1Database, type: TelegramAlertType, nowSec: number) => Promise<SubscriberRow[]>;
  loadPerCoinSnoozeMap: (
    db: D1Database,
    stablecoinIds: readonly string[],
    nowSec: number,
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
): Promise<FanoutSubscriptionInputs> {
  const {
    dewsIds,
    depegIds,
    safetyIds,
    launchIds,
  } = ids;
  const [
    directDewsSubs,
    directDepegSubs,
    directSafetySubs,
    launchSubs,
    presetDewsResult,
    presetDepegResult,
    presetSafetyResult,
    globalDewsSubs,
    globalDepegSubs,
    globalSafetySubs,
    globalLaunchSubs,
    perCoinSnoozeMap,
  ] = await Promise.all([
    loaders.loadSubscriberRowsBatch(db, dewsIds, "dews", nowSec),
    loaders.loadSubscriberRowsBatch(db, depegIds, "depeg", nowSec),
    loaders.loadSubscriberRowsBatch(db, safetyIds, "safety", nowSec),
    loaders.loadSubscriberRowsBatch(db, launchIds, "launch", nowSec),
    loaders.loadPresetSubscriberRowsBatch(db, dewsIds, "dews", nowSec),
    loaders.loadPresetSubscriberRowsBatch(db, depegIds, "depeg", nowSec),
    loaders.loadPresetSubscriberRowsBatch(db, safetyIds, "safety", nowSec),
    loaders.loadGlobalSubscriberRows(db, "dews", nowSec),
    loaders.loadGlobalSubscriberRows(db, "depeg", nowSec),
    loaders.loadGlobalSubscriberRows(db, "safety", nowSec),
    loaders.loadGlobalSubscriberRows(db, "launch", nowSec),
    loaders.loadPerCoinSnoozeMap(db, [...dewsIds, ...depegIds, ...safetyIds, ...launchIds], nowSec),
  ]);

  return {
    directDewsSubs,
    directDepegSubs,
    directSafetySubs,
    launchSubs,
    presetDewsResult,
    presetDepegResult,
    presetSafetyResult,
    globalDewsSubs,
    globalDepegSubs,
    globalSafetySubs,
    globalLaunchSubs,
    perCoinSnoozeMap,
  };
}
