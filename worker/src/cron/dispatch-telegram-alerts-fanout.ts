import type { TelegramAlertType } from "@shared/types/status";
import { GLOBAL_ALERT_COLUMN_BY_TYPE } from "../lib/telegram-broadcast-targets";
import type { ConsolidatedAlerts } from "../lib/telegram-alerts";
import type { TelegramFanoutPlanEvents } from "./dispatch-telegram-events";
import {
  meetsDepegStepThreshold,
  meetsDewsThreshold,
  shouldIncludeDepegWorsening,
  shouldIncludeSafetyForSubscriber,
} from "./dispatch-telegram-predicates";
import type { SubscriberRow } from "./dispatch-telegram-routing";
import type { PendingCapacitySnapshot } from "./telegram-pending";

export type LegacyFanoutAlertType = Exclude<TelegramAlertType, "freeze">;
export type PresetFanoutAlertType = Exclude<LegacyFanoutAlertType, "launch" | "reserve">;

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

type RoutedEventKey = Exclude<keyof TelegramFanoutPlanEvents, "safetyScoreIdentity">;
type RoutedAlertKey = Exclude<keyof ConsolidatedAlerts, "burst" | "freeze">;
type RoutedEvent = TelegramFanoutPlanEvents[RoutedEventKey][number];

interface TelegramFanoutRoute {
  eventKey: RoutedEventKey;
  alertKey: RoutedAlertKey;
  shouldInclude?: (subscriber: SubscriberRow, event: RoutedEvent) => boolean;
}

function route<K extends RoutedEventKey>(
  eventKey: K,
  alertKey: RoutedAlertKey,
  shouldInclude?: (subscriber: SubscriberRow, event: TelegramFanoutPlanEvents[K][number]) => boolean,
): TelegramFanoutRoute {
  return {
    eventKey,
    alertKey,
    shouldInclude: shouldInclude as TelegramFanoutRoute["shouldInclude"],
  };
}

export const TELEGRAM_FANOUT_FAMILIES = [
  {
    family: "dews", idsKey: "dewsIds", presetFamily: "dews",
    directColumn: "alert_dews", globalColumn: GLOBAL_ALERT_COLUMN_BY_TYPE.dews,
    overrideColumn: "alert_dews_override",
    routes: [route("dewsChanges", "dews", (sub, change) => meetsDewsThreshold(change.newBand, sub.dews_min_band))],
  },
  {
    family: "depeg", idsKey: "depegIds", presetFamily: "depeg",
    directColumn: "alert_depeg", globalColumn: GLOBAL_ALERT_COLUMN_BY_TYPE.depeg,
    overrideColumn: "alert_depeg_override",
    routes: [
      route("depegTriggered", "depegTriggered", (sub, event) =>
        meetsDepegStepThreshold(event.deviationBps, sub.depeg_worsening_bps_step)),
      route("depegResolved", "depegResolved", (sub, event) =>
        meetsDepegStepThreshold(event.peakDeviationBps, sub.depeg_worsening_bps_step)),
      route("depegWorsening", "depegWorsening", shouldIncludeDepegWorsening),
    ],
  },
  {
    family: "safety", idsKey: "safetyIds", presetFamily: "safety",
    directColumn: "alert_safety", globalColumn: GLOBAL_ALERT_COLUMN_BY_TYPE.safety,
    overrideColumn: "alert_safety_override",
    routes: [route("safetyChanges", "safety", shouldIncludeSafetyForSubscriber)],
  },
  {
    family: "launch", idsKey: "launchIds", presetFamily: null,
    directColumn: "alert_launch", globalColumn: GLOBAL_ALERT_COLUMN_BY_TYPE.launch,
    overrideColumn: "alert_launch_override",
    routes: [route("launchPromoted", "launch")],
  },
  {
    family: "reserve", idsKey: "reserveIds", presetFamily: null,
    directColumn: "alert_reserve", globalColumn: GLOBAL_ALERT_COLUMN_BY_TYPE.reserve,
    overrideColumn: "alert_reserve_override",
    routes: [route("reservePromoted", "reserve")],
  },
] as const;

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
  direct: Record<LegacyFanoutAlertType, Map<string, SubscriberRow[]>>;
  preset: Record<PresetFanoutAlertType, PresetSubscriberLoadResult>;
  global: Record<LegacyFanoutAlertType, SubscriberRow[]>;
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
    type: PresetFanoutAlertType,
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
  const timed = async <T>(family: FanoutLoaderFamily, load: () => Promise<T>): Promise<T> => {
    const startedAtMs = Date.now();
    try {
      return await load();
    } finally {
      options.onLoaderTiming?.(family, Math.max(0, Date.now() - startedAtMs));
    }
  };
  const emptyPresetResult = (): PresetSubscriberLoadResult => ({ kind: "ok", rows: new Map() });
  const families = TELEGRAM_FANOUT_FAMILIES.map((spec) => ({ ...spec, stablecoinIds: ids[spec.idsKey] }));
  const presetFamilies = families.filter((spec) => spec.presetFamily != null);
  const loadFamily = <T>(
    spec: (typeof families)[number],
    empty: T,
    loaderFamily: FanoutLoaderFamily,
    load: (stablecoinIds: string[]) => Promise<T>,
  ) => spec.stablecoinIds.length > 0 ? timed(loaderFamily, () => load(spec.stablecoinIds)) : empty;
  const allStablecoinIds = families.flatMap((spec) => spec.stablecoinIds);
  const [
    directResults,
    presetResults,
    globalResults,
    perCoinSnoozeMap,
    explicitlyOffResults,
  ] = await Promise.all([
    Promise.all(families.map((spec) => loadFamily(spec, new Map<string, SubscriberRow[]>(), "direct",
      (stablecoinIds) => loaders.loadSubscriberRowsBatch(db, stablecoinIds, spec.family, nowSec, options)))),
    Promise.all(presetFamilies.map((spec) => loadFamily(spec, emptyPresetResult(), "preset",
      (stablecoinIds) => loaders.loadPresetSubscriberRowsBatch(db, stablecoinIds, spec.presetFamily, nowSec)))),
    Promise.all(families.map((spec) => loadFamily(spec, [], "global",
      () => loaders.loadGlobalSubscriberRows(db, spec.family, nowSec, options)))),
    allStablecoinIds.length > 0
      ? timed("snooze-explicit-off", () =>
        loaders.loadPerCoinSnoozeMap(db, allStablecoinIds, nowSec, options))
      : new Map(),
    Promise.all(families.map((spec) => loadFamily(spec, new Map<string, Set<string>>(), "snooze-explicit-off",
      (stablecoinIds) => loaders.loadPerCoinExplicitlyOffMap(db, stablecoinIds, spec.family, options)))),
  ]);

  return {
    direct: Object.fromEntries(TELEGRAM_FANOUT_FAMILIES.map((spec, index) =>
      [spec.family, directResults[index]])),
    preset: Object.fromEntries(presetFamilies.map((spec, index) =>
      [spec.presetFamily, presetResults[index]])),
    global: Object.fromEntries(TELEGRAM_FANOUT_FAMILIES.map((spec, index) =>
      [spec.family, globalResults[index]])),
    perCoinSnoozeMap,
    perCoinExplicitlyOffMaps: Object.fromEntries(TELEGRAM_FANOUT_FAMILIES.map((spec, index) =>
      [spec.family, explicitlyOffResults[index]])),
  } as FanoutSubscriptionInputs;
}
