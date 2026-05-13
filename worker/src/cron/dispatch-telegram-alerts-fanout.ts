import type { SubscriberRow } from "./dispatch-telegram-routing";

type AlertType = "dews" | "depeg" | "safety" | "launch";

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
    type: AlertType,
  ) => Promise<Map<string, SubscriberRow[]>>;
  loadPresetSubscriberRowsBatch: (
    db: D1Database,
    stablecoinIds: string[],
    type: Exclude<AlertType, "launch">,
  ) => Promise<PresetSubscriberLoadResult>;
  loadGlobalSubscriberRows: (db: D1Database, type: AlertType) => Promise<SubscriberRow[]>;
  loadPerCoinSnoozeMap: (
    db: D1Database,
    stablecoinIds: readonly string[],
  ) => Promise<Map<string, Set<string>>>;
}

export interface PendingCapacitySnapshot {
  active: number;
  due: number;
  deferred: number;
  expired: number;
  nearTtl: number;
  oldestPendingAgeSec: number | null;
  oldestDuePendingAgeSec: number | null;
  estimatedDrainTimeSec: number;
  drainBudgetPerRun: number;
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
    loaders.loadSubscriberRowsBatch(db, dewsIds, "dews"),
    loaders.loadSubscriberRowsBatch(db, depegIds, "depeg"),
    loaders.loadSubscriberRowsBatch(db, safetyIds, "safety"),
    loaders.loadSubscriberRowsBatch(db, launchIds, "launch"),
    loaders.loadPresetSubscriberRowsBatch(db, dewsIds, "dews"),
    loaders.loadPresetSubscriberRowsBatch(db, depegIds, "depeg"),
    loaders.loadPresetSubscriberRowsBatch(db, safetyIds, "safety"),
    loaders.loadGlobalSubscriberRows(db, "dews"),
    loaders.loadGlobalSubscriberRows(db, "depeg"),
    loaders.loadGlobalSubscriberRows(db, "safety"),
    loaders.loadGlobalSubscriberRows(db, "launch"),
    loaders.loadPerCoinSnoozeMap(db, [...dewsIds, ...depegIds, ...safetyIds, ...launchIds]),
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
