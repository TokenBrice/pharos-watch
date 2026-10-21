import type { TelegramFanoutPlanEvents } from "../sources/dispatch-telegram-events";
import {
  TELEGRAM_FANOUT_FAMILIES,
  type FanoutSubscriptionInputs,
} from "./dispatch-telegram-alerts-fanout";
import {
  routeAlertEvents,
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
