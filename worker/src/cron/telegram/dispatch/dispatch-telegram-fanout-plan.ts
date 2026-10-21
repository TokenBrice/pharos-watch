import type { TelegramFanoutPlanEvents } from "../sources/dispatch-telegram-events";
import {
  TELEGRAM_FANOUT_FAMILIES,
  type FanoutSubscriptionInputs,
} from "./dispatch-telegram-alerts-fanout";
import { hasEscalation } from "./dispatch-telegram-predicates";
import { isQuietHoursActive } from "../../../telegram/common/quiet-hours";
import {
  formatPlannedSubscribers,
  planSubscriberQueue,
  routeAlertEvents,
  type RoutedSubscriberAlert,
  type AlertsByChatEntry,
} from "./dispatch-telegram-routing";
import { mergeSubscriberMaps } from "./dispatch-telegram-subscribers";

interface TelegramFanoutRoutingArgs {
  events: TelegramFanoutPlanEvents;
  inputs: FanoutSubscriptionInputs;
}

export interface TelegramFanoutRoutingResult {
  alertsByChat: Map<string, AlertsByChatEntry>;
}

/** Route and filter one subscriber page without formatting any message HTML. */
export function buildTelegramAlertsByChat(
  args: TelegramFanoutRoutingArgs,
): TelegramFanoutRoutingResult {
  const { events, inputs } = args;

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
        family.family,
      );
    }
  }

  return { alertsByChat };
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
