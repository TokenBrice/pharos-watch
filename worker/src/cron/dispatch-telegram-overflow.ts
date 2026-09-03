import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import {
  formatPlannedSubscribers,
  planSubscriberQueue,
  selectChatsToFormat,
  type AlertsByChatEntry,
  type PlannedSubscriberAlert,
  type RoutedSubscriberAlert,
} from "./dispatch-telegram-routing";
import { hasEscalation } from "./dispatch-telegram-predicates";
import { isQuietHoursActive } from "../lib/telegram/quiet-hours";

export { pruneOverflowPlanBacklogForChat } from "../lib/telegram/overflow-plan-cache";

export function buildOverflowAwareSubscriberQueue(args: {
  alertsByChat: Map<string, AlertsByChatEntry>;
  nowSec: number;
  formatBudget: number;
  sourceEventId?: string;
  safetyScoreIdentity?: SafetyScorePublicationIdentity | null;
}): {
  plannedQueue: PlannedSubscriberAlert[];
  subscriberQueue: RoutedSubscriberAlert[];
  overflowPlanned: PlannedSubscriberAlert[];
  resolveDisableNotification: (entry: AlertsByChatEntry) => boolean;
} {
  const resolveDisableNotification = (entry: AlertsByChatEntry): boolean =>
    !hasEscalation(entry.alerts) ||
    isQuietHoursActive(
      args.nowSec,
      entry.quietHoursEnabled,
      entry.quietHoursStartUtc,
      entry.quietHoursEndUtc,
      entry.timezone,
    );
  const plannedQueue = planSubscriberQueue(
    args.alertsByChat,
    args.sourceEventId,
    args.safetyScoreIdentity,
  );
  const { toFormat, overflow } = selectChatsToFormat(plannedQueue, args.formatBudget);
  const subscriberQueue = formatPlannedSubscribers(toFormat, resolveDisableNotification);
  return {
    plannedQueue,
    subscriberQueue,
    overflowPlanned: overflow,
    resolveDisableNotification,
  };
}
