import {
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
} from "../lib/telegram-constants";
import type { TelegramDispatchEvents } from "./dispatch-telegram-events";
import type { FanoutSubscriptionInputs } from "./dispatch-telegram-alerts-fanout";
import { buildOverflowAwareSubscriberQueue } from "./dispatch-telegram-overflow";
import {
  collapseBurstChats,
  routeAlertEvents,
  type BurstMarkerMap,
  type PlannedSubscriberAlert,
  type RoutedSubscriberAlert,
  type AlertsByChatEntry,
  type SubscriberRow,
} from "./dispatch-telegram-routing";
import {
  meetsDepegStepThreshold,
  meetsDewsThreshold,
  shouldIncludeDepegWorsening,
  shouldIncludeSafetyForSubscriber,
} from "./dispatch-telegram-predicates";
import {
  buildPerAlertTypeTargets,
  type PerAlertTypeTargets,
} from "./dispatch-telegram-result";
import { mergeSubscriberMaps } from "./dispatch-telegram-subscribers";
import { removeHandledTelegramAlertItems } from "./telegram-alert-event-lineage";

export type TelegramFanoutPlanEvents = Pick<
  TelegramDispatchEvents,
  | "dewsChanges"
  | "depegTriggered"
  | "depegResolved"
  | "depegWorsening"
  | "safetyChanges"
  | "launchPromoted"
  | "reservePromoted"
>;

export interface PresetFanoutFailureSummary {
  presetQueryFailures: number;
  presetResolutionFailures: number;
  presetFailure: boolean;
}

export interface TelegramFanoutPlan {
  plannedQueue: PlannedSubscriberAlert[];
  subscriberQueue: RoutedSubscriberAlert[];
  overflowPlanned: PlannedSubscriberAlert[];
  combinedOverflowPlanned: PlannedSubscriberAlert[];
  overflowFormatBudget: number;
  resolveDisableNotification: (entry: AlertsByChatEntry) => boolean;
  perAlertTypeTargets: PerAlertTypeTargets;
  freshCandidateChats: number;
  freshCandidateCount: number;
  formattedChats: number;
  burstOutcome: ReturnType<typeof collapseBurstChats>;
  presetQueryFailures: number;
  presetResolutionFailures: number;
  presetFailure: boolean;
  handledItemsPruned: number;
}

export function summarizePresetFanoutFailures(
  inputs: Pick<FanoutSubscriptionInputs, "presetDewsResult" | "presetDepegResult" | "presetSafetyResult">,
): PresetFanoutFailureSummary {
  const presetResults = [inputs.presetDewsResult, inputs.presetDepegResult, inputs.presetSafetyResult];
  const presetQueryFailures = presetResults.reduce(
    (count, result) => count + (
      result.kind === "query-failed"
        ? 1
        : result.kind === "partial"
          ? result.queryFailures
          : 0
    ),
    0,
  );
  const presetResolutionFailures = presetResults.reduce(
    (count, result) => count + (
      result.kind === "resolution-failed"
        ? 1
        : result.kind === "partial"
          ? result.resolutionFailures
          : 0
    ),
    0,
  );
  return {
    presetQueryFailures,
    presetResolutionFailures,
    presetFailure: presetQueryFailures > 0 || presetResolutionFailures > 0,
  };
}

export function buildTelegramFanoutPlan(args: {
  events: TelegramFanoutPlanEvents;
  inputs: FanoutSubscriptionInputs;
  overflowBacklog: readonly PlannedSubscriberAlert[];
  burstMarkers: BurstMarkerMap;
  nowSec: number;
  formatBudget?: number;
  presetFailureSummary?: PresetFanoutFailureSummary;
  handledItemsByChat?: ReadonlyMap<string, ReadonlySet<string>>;
  collapseBursts?: boolean;
  sourceEventId?: string;
}): TelegramFanoutPlan {
  const {
    events,
    inputs,
    overflowBacklog,
    burstMarkers,
    nowSec,
    formatBudget = TELEGRAM_MAX_MESSAGES_PER_RUN + TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
    presetFailureSummary = summarizePresetFanoutFailures(inputs),
    handledItemsByChat = new Map(),
    collapseBursts = true,
  } = args;

  const presetDewsSubs = inputs.presetDewsResult.kind === "ok" || inputs.presetDewsResult.kind === "partial"
    ? inputs.presetDewsResult.rows
    : new Map<string, SubscriberRow[]>();
  const presetDepegSubs = inputs.presetDepegResult.kind === "ok" || inputs.presetDepegResult.kind === "partial"
    ? inputs.presetDepegResult.rows
    : new Map<string, SubscriberRow[]>();
  const presetSafetySubs = inputs.presetSafetyResult.kind === "ok" || inputs.presetSafetyResult.kind === "partial"
    ? inputs.presetSafetyResult.rows
    : new Map<string, SubscriberRow[]>();
  const dewsSubs = mergeSubscriberMaps(inputs.directDewsSubs, presetDewsSubs);
  const depegSubs = mergeSubscriberMaps(inputs.directDepegSubs, presetDepegSubs);
  const safetySubs = mergeSubscriberMaps(inputs.directSafetySubs, presetSafetySubs);

  const alertsByChat = new Map<string, AlertsByChatEntry>();
  routeAlertEvents(
    events.dewsChanges,
    dewsSubs,
    inputs.globalDewsSubs,
    alertsByChat,
    (alerts) => alerts.dews,
    (sub, change) => meetsDewsThreshold(change.newBand, sub.dews_min_band),
    inputs.perCoinSnoozeMap,
    inputs.perCoinExplicitlyOffMaps.dews,
  );
  routeAlertEvents(
    events.depegTriggered,
    depegSubs,
    inputs.globalDepegSubs,
    alertsByChat,
    (alerts) => alerts.depegTriggered,
    (sub, event) => meetsDepegStepThreshold(event.deviationBps, sub.depeg_worsening_bps_step),
    inputs.perCoinSnoozeMap,
    inputs.perCoinExplicitlyOffMaps.depeg,
  );
  routeAlertEvents(
    events.depegResolved,
    depegSubs,
    inputs.globalDepegSubs,
    alertsByChat,
    (alerts) => alerts.depegResolved,
    (sub, event) => meetsDepegStepThreshold(event.peakDeviationBps, sub.depeg_worsening_bps_step),
    inputs.perCoinSnoozeMap,
    inputs.perCoinExplicitlyOffMaps.depeg,
  );
  routeAlertEvents(
    events.depegWorsening,
    depegSubs,
    inputs.globalDepegSubs,
    alertsByChat,
    (alerts) => alerts.depegWorsening,
    shouldIncludeDepegWorsening,
    inputs.perCoinSnoozeMap,
    inputs.perCoinExplicitlyOffMaps.depeg,
  );
  routeAlertEvents(
    events.safetyChanges,
    safetySubs,
    inputs.globalSafetySubs,
    alertsByChat,
    (alerts) => alerts.safety,
    shouldIncludeSafetyForSubscriber,
    inputs.perCoinSnoozeMap,
    inputs.perCoinExplicitlyOffMaps.safety,
  );
  routeAlertEvents(
    events.launchPromoted,
    inputs.launchSubs,
    inputs.globalLaunchSubs,
    alertsByChat,
    (alerts) => alerts.launch,
    undefined,
    inputs.perCoinSnoozeMap,
    inputs.perCoinExplicitlyOffMaps.launch,
  );
  routeAlertEvents(
    events.reservePromoted,
    inputs.reserveSubs,
    inputs.globalReserveSubs,
    alertsByChat,
    (alerts) => alerts.reserve,
    undefined,
    inputs.perCoinSnoozeMap,
    inputs.perCoinExplicitlyOffMaps.reserve,
  );

  const handledItemsPruned = removeHandledTelegramAlertItems(alertsByChat, handledItemsByChat);
  const burstOutcome = collapseBursts
    ? collapseBurstChats(alertsByChat, burstMarkers, nowSec)
    : { markers: burstMarkers, collapsedChats: 0, deltaSuppressed: 0 };
  const {
    plannedQueue,
    subscriberQueue,
    overflowPlanned,
    combinedOverflowPlanned,
    overflowFormatBudget,
    resolveDisableNotification,
  } = buildOverflowAwareSubscriberQueue({
    alertsByChat,
    overflowBacklog,
    nowSec,
    formatBudget,
    sourceEventId: args.sourceEventId,
  });

  return {
    plannedQueue,
    subscriberQueue,
    overflowPlanned,
    combinedOverflowPlanned,
    overflowFormatBudget,
    resolveDisableNotification,
    perAlertTypeTargets: buildPerAlertTypeTargets(subscriberQueue),
    freshCandidateChats: plannedQueue.length,
    freshCandidateCount: plannedQueue.reduce((sum, plan) => sum + plan.estimatedChunks, 0),
    formattedChats: subscriberQueue.length,
    burstOutcome,
    handledItemsPruned,
    ...presetFailureSummary,
  };
}
