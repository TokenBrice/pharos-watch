import type { TelegramFanoutPlanEvents } from "./dispatch-telegram-events";
import {
  TELEGRAM_FANOUT_FAMILIES,
  type FanoutSubscriptionInputs,
} from "./dispatch-telegram-alerts-fanout";
import { hasEscalation } from "./dispatch-telegram-predicates";
import { isQuietHoursActive } from "../lib/telegram/quiet-hours";
import {
  formatPlannedSubscribers,
  planSubscriberQueue,
  routeAlertEvents,
  type RoutedSubscriberAlert,
  type AlertsByChatEntry,
} from "./dispatch-telegram-routing";
import { mergeSubscriberMaps } from "./dispatch-telegram-subscribers";
import { removeHandledTelegramAlertItems } from "./telegram-alert-event-lineage";

export interface PresetFanoutFailureSummary {
  presetQueryFailures: number;
  presetResolutionFailures: number;
  presetFailure: boolean;
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
      result.kind === "partial" ? result.resolutionFailures : 0
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
  presetFailureSummary?: PresetFanoutFailureSummary;
  handledItemsByChat?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface TelegramFanoutRoutingResult extends PresetFanoutFailureSummary {
  alertsByChat: Map<string, AlertsByChatEntry>;
  handledItemsPruned: number;
}

/** Route and filter one subscriber page without formatting any message HTML. */
export function buildTelegramAlertsByChat(
  args: TelegramFanoutRoutingArgs,
): TelegramFanoutRoutingResult {
  const {
    events,
    inputs,
    presetFailureSummary = summarizePresetFanoutFailures(inputs),
    handledItemsByChat = new Map(),
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
  return {
    alertsByChat,
    handledItemsPruned,
    ...presetFailureSummary,
  };
}

/** Render the entire authoritative page, or reject it before persisting any target. */
export function renderTelegramSubscriberPage(args: TelegramFanoutRoutingArgs & {
  nowSec: number;
  formatBudget: number;
  sourceEventId?: string;
}): RoutedSubscriberAlert[] {
  const { alertsByChat } = buildTelegramAlertsByChat(args);
  const planned = planSubscriberQueue(alertsByChat, args.sourceEventId, args.events.safetyScoreIdentity);
  let allocated = 0;
  for (const [index, plan] of planned.entries()) {
    // The first candidate is admitted even when its estimate exceeds the budget.
    if (index > 0 && allocated + plan.estimatedChunks > args.formatBudget) {
      throw new Error("Telegram subscriber page exceeded the bounded rendering budget");
    }
    allocated += plan.estimatedChunks;
  }
  return formatPlannedSubscribers(planned, (entry) =>
    !hasEscalation(entry.alerts) || isQuietHoursActive(
      args.nowSec,
      entry.quietHoursEnabled,
      entry.quietHoursStartUtc,
      entry.quietHoursEndUtc,
      entry.timezone,
    ));
}
