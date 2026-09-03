import {
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
} from "../lib/telegram/constants";
import type { TelegramFanoutPlanEvents } from "./dispatch-telegram-events";
export type { TelegramFanoutPlanEvents } from "./dispatch-telegram-events";
import {
  TELEGRAM_FANOUT_FAMILIES,
  type FanoutSubscriptionInputs,
} from "./dispatch-telegram-alerts-fanout";
import { buildOverflowAwareSubscriberQueue } from "./dispatch-telegram-overflow";
import {
  collapseBurstChats,
  routeAlertEvents,
  type BurstMarkerMap,
  type PlannedSubscriberAlert,
  type RoutedSubscriberAlert,
  type AlertsByChatEntry,
} from "./dispatch-telegram-routing";
import {
  buildPerAlertTypeTargets,
  type PerAlertTypeTargets,
} from "./dispatch-telegram-result";
import { mergeSubscriberMaps } from "./dispatch-telegram-subscribers";
import { removeHandledTelegramAlertItems } from "./telegram-alert-event-lineage";

export interface PresetFanoutFailureSummary {
  presetQueryFailures: number;
  presetResolutionFailures: number;
  presetFailure: boolean;
}

export interface TelegramFanoutPlan {
  plannedQueue: PlannedSubscriberAlert[];
  subscriberQueue: RoutedSubscriberAlert[];
  overflowPlanned: PlannedSubscriberAlert[];
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
  inputs: Pick<FanoutSubscriptionInputs, "preset">,
): PresetFanoutFailureSummary {
  const presetResults = TELEGRAM_FANOUT_FAMILIES.flatMap((spec) =>
    spec.presetFamily == null ? [] : [inputs.preset[spec.presetFamily]]);
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

interface TelegramFanoutRoutingArgs {
  events: TelegramFanoutPlanEvents;
  inputs: FanoutSubscriptionInputs;
  burstMarkers: BurstMarkerMap;
  nowSec: number;
  presetFailureSummary?: PresetFanoutFailureSummary;
  handledItemsByChat?: ReadonlyMap<string, ReadonlySet<string>>;
  collapseBursts?: boolean;
}

export interface TelegramFanoutRoutingResult extends PresetFanoutFailureSummary {
  alertsByChat: Map<string, AlertsByChatEntry>;
  burstOutcome: ReturnType<typeof collapseBurstChats>;
  handledItemsPruned: number;
}

/** Route and filter one subscriber page without formatting any message HTML. */
export function buildTelegramAlertsByChat(
  args: TelegramFanoutRoutingArgs,
): TelegramFanoutRoutingResult {
  const {
    events,
    inputs,
    burstMarkers,
    nowSec,
    presetFailureSummary = summarizePresetFanoutFailures(inputs),
    handledItemsByChat = new Map(),
    collapseBursts = true,
  } = args;

  const alertsByChat = new Map<string, AlertsByChatEntry>();
  for (const family of TELEGRAM_FANOUT_FAMILIES) {
    const presetResult = family.presetFamily == null ? null : inputs.preset[family.presetFamily];
    const specificSubscribers = presetResult?.kind === "ok" || presetResult?.kind === "partial"
      ? mergeSubscriberMaps(inputs.direct[family.family], presetResult.rows)
      : inputs.direct[family.family];
    for (const route of family.routes) {
      routeAlertEvents(
        events[route.eventKey],
        specificSubscribers,
        inputs.global[family.family],
        alertsByChat,
        (alerts) => alerts[route.alertKey],
        route.shouldInclude,
        inputs.perCoinSnoozeMap,
        inputs.perCoinExplicitlyOffMaps[family.family],
      );
    }
  }

  const handledItemsPruned = removeHandledTelegramAlertItems(alertsByChat, handledItemsByChat);
  const burstOutcome = collapseBursts
    ? collapseBurstChats(alertsByChat, burstMarkers, nowSec)
    : { markers: burstMarkers, collapsedChats: 0, deltaSuppressed: 0 };
  return {
    alertsByChat,
    burstOutcome,
    handledItemsPruned,
    ...presetFailureSummary,
  };
}

export function buildTelegramFanoutPlan(args: {
  events: TelegramFanoutPlanEvents;
  inputs: FanoutSubscriptionInputs;
  burstMarkers: BurstMarkerMap;
  nowSec: number;
  formatBudget?: number;
  presetFailureSummary?: PresetFanoutFailureSummary;
  handledItemsByChat?: ReadonlyMap<string, ReadonlySet<string>>;
  collapseBursts?: boolean;
  sourceEventId?: string;
}): TelegramFanoutPlan {
  const {
    nowSec,
    formatBudget = TELEGRAM_MAX_MESSAGES_PER_RUN + TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  } = args;
  const routing = buildTelegramAlertsByChat(args);
  const { alertsByChat } = routing;
  const {
    plannedQueue,
    subscriberQueue,
    overflowPlanned,
    resolveDisableNotification,
  } = buildOverflowAwareSubscriberQueue({
    alertsByChat,
    nowSec,
    formatBudget,
    sourceEventId: args.sourceEventId,
    safetyScoreIdentity: args.events.safetyScoreIdentity ?? null,
  });

  return {
    plannedQueue,
    subscriberQueue,
    overflowPlanned,
    resolveDisableNotification,
    perAlertTypeTargets: buildPerAlertTypeTargets(subscriberQueue),
    freshCandidateChats: plannedQueue.length,
    freshCandidateCount: plannedQueue.reduce((sum, plan) => sum + plan.estimatedChunks, 0),
    formattedChats: subscriberQueue.length,
    burstOutcome: routing.burstOutcome,
    handledItemsPruned: routing.handledItemsPruned,
    presetQueryFailures: routing.presetQueryFailures,
    presetResolutionFailures: routing.presetResolutionFailures,
    presetFailure: routing.presetFailure,
  };
}
