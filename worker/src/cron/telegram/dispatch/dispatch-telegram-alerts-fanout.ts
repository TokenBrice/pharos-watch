import type { TelegramAlertType } from "@shared/types/status";
import type { ConsolidatedAlerts } from "../../../telegram/common/alerts-formatting";
import type { TelegramFanoutPlanEvents } from "../sources/dispatch-telegram-events";
import {
  meetsDepegStepThreshold,
  meetsDewsThreshold,
  shouldIncludeDepegWorsening,
  shouldIncludeSafetyForSubscriber,
} from "./dispatch-telegram-predicates";
import type { SubscriberRow } from "./dispatch-telegram-routing";

export type LegacyFanoutAlertType = Exclude<TelegramAlertType, "freeze" | "launch">;
export type PresetFanoutAlertType = Exclude<LegacyFanoutAlertType, "reserve">;

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
  reserveIds: string[];
}

type RoutedEventKey = Exclude<keyof TelegramFanoutPlanEvents, "safetyScoreIdentity">;
type RoutedAlertKey = Exclude<keyof ConsolidatedAlerts, "freeze">;
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
    routes: [route("dewsChanges", "dews", (sub, change) => meetsDewsThreshold(change.newBand, sub.dews_min_band))],
  },
  {
    family: "depeg", idsKey: "depegIds", presetFamily: "depeg",
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
    routes: [route("safetyChanges", "safety", shouldIncludeSafetyForSubscriber)],
  },
  {
    family: "reserve", idsKey: "reserveIds", presetFamily: null,
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
  loadPresetSubscribers: (
    db: D1Database,
    stablecoinIds: string[],
    type: PresetFanoutAlertType,
    nowSec: number,
    options?: FanoutSubscriberLoadOptions,
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
      (stablecoinIds) => loaders.loadPresetSubscribers(db, stablecoinIds, spec.presetFamily, nowSec, options)))),
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
