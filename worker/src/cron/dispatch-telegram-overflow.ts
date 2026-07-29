import { isRecord, numberValue as finiteNumber } from "@shared/lib/type-guards";
import { isTelegramAlertType } from "@shared/types/status";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import {
  formatPlannedSubscribers,
  planSubscriberQueue,
  selectChatsToFormat,
  type AlertsByChatEntry,
  type PlannedSubscriberAlert,
  type RoutedSubscriberAlert,
} from "./dispatch-telegram-routing";
import { hasEscalation } from "./dispatch-telegram-predicates";
import { isQuietHoursActive } from "./telegram-quiet-hours";
import { isValidPendingSourceEventId } from "../lib/telegram-pending-provenance";

export {
  OVERFLOW_PLAN_CACHE_KEY,
  pruneOverflowPlanBacklogForChat,
} from "../lib/telegram-overflow-plan-cache";

export const OVERFLOW_PLAN_CACHE_VERSION = 1;
export const LEGACY_OVERFLOW_MAX_PLAN_COUNT = 5_000;

export type OverflowPlannedSubscriberAlert = PlannedSubscriberAlert & { expiresAt: number };

export type ParsedLegacyOverflowPlanBacklog =
  | { kind: "ok"; plans: OverflowPlannedSubscriberAlert[]; writtenAt: number | null }
  | { kind: "invalid"; reason: string };

function normalizeCachedAlerts(value: unknown): AlertsByChatEntry["alerts"] | null {
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.dews) ||
    !Array.isArray(value.depegTriggered) ||
    !Array.isArray(value.depegResolved) ||
    !Array.isArray(value.depegWorsening) ||
    !Array.isArray(value.safety) ||
    !Array.isArray(value.launch)
  ) {
    return null;
  }
  return {
    dews: value.dews as AlertsByChatEntry["alerts"]["dews"],
    depegTriggered: value.depegTriggered as AlertsByChatEntry["alerts"]["depegTriggered"],
    depegResolved: value.depegResolved as AlertsByChatEntry["alerts"]["depegResolved"],
    depegWorsening: value.depegWorsening as AlertsByChatEntry["alerts"]["depegWorsening"],
    safety: value.safety as AlertsByChatEntry["alerts"]["safety"],
    launch: value.launch as AlertsByChatEntry["alerts"]["launch"],
    reserve: Array.isArray(value.reserve) ? value.reserve as AlertsByChatEntry["alerts"]["reserve"] : [],
    burst: isRecord(value.burst) || value.burst === null
      ? value.burst as AlertsByChatEntry["alerts"]["burst"]
      : undefined,
  };
}

function normalizeCachedOverflowPlan(value: unknown, _nowSec: number): OverflowPlannedSubscriberAlert | null {
  if (!isRecord(value)) return null;
  const chatId = typeof value.chatId === "string" ? value.chatId : null;
  const alertType = isTelegramAlertType(value.alertType) ? value.alertType : null;
  const estimatedChunks = finiteNumber(value.estimatedChunks);
  const expiresAt = finiteNumber(value.expiresAt);
  const rawEntry = isRecord(value.entry) ? value.entry : null;
  const alerts = rawEntry ? normalizeCachedAlerts(rawEntry.alerts) : null;
  const lastActiveAt = rawEntry ? finiteNumber(rawEntry.lastActiveAt) : null;
  const sourceEventId = typeof value.sourceEventId === "string" && isValidPendingSourceEventId(value.sourceEventId)
    ? value.sourceEventId
    : undefined;
  const preferenceGeneration = rawEntry ? finiteNumber(rawEntry.preferenceGeneration) : null;
  const parsedSafetyIdentity = value.safetyScoreIdentity == null
    ? null
    : SafetyScorePublicationIdentitySchema.safeParse(value.safetyScoreIdentity);
  if (parsedSafetyIdentity && !parsedSafetyIdentity.success) return null;

  if (
    chatId == null || chatId.length === 0 || chatId.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(chatId) ||
    alertType == null ||
    estimatedChunks == null ||
    !Number.isSafeInteger(estimatedChunks) ||
    estimatedChunks < 1 ||
    estimatedChunks > 64 ||
    expiresAt == null ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0 ||
    rawEntry == null ||
    alerts == null ||
    lastActiveAt == null
  ) {
    return null;
  }
  const itemCount = alerts.dews.length + alerts.depegTriggered.length + alerts.depegResolved.length +
    alerts.depegWorsening.length + alerts.safety.length + alerts.launch.length + alerts.reserve.length +
    (alerts.burst ? 1 : 0);
  if (itemCount < 1 || itemCount > 512) return null;

  return {
    chatId,
    alertType,
    ...(sourceEventId ? { sourceEventId } : {}),
    ...(parsedSafetyIdentity?.data ? { safetyScoreIdentity: parsedSafetyIdentity.data } : {}),
    estimatedChunks: Math.max(1, Math.min(64, Math.floor(estimatedChunks))),
    expiresAt: Math.floor(expiresAt),
    entry: {
      lastActiveAt,
      alerts,
      quietHoursEnabled: rawEntry.quietHoursEnabled === true,
      quietHoursStartUtc: finiteNumber(rawEntry.quietHoursStartUtc),
      quietHoursEndUtc: finiteNumber(rawEntry.quietHoursEndUtc),
      timezone: typeof rawEntry.timezone === "string" ? rawEntry.timezone : null,
      preferenceGeneration: preferenceGeneration != null && preferenceGeneration >= 0
        ? Math.floor(preferenceGeneration)
        : 0,
      specificCount: finiteNumber(rawEntry.specificCount) ?? 0,
      globalCount: finiteNumber(rawEntry.globalCount) ?? 0,
    },
  };
}

export function parseLegacyOverflowPlanBacklog(value: string): ParsedLegacyOverflowPlanBacklog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { kind: "invalid", reason: "legacy_overflow_json_invalid" };
  }
  if (!isRecord(parsed) || parsed.version !== OVERFLOW_PLAN_CACHE_VERSION || !Array.isArray(parsed.plans)) {
    return { kind: "invalid", reason: "legacy_overflow_schema_invalid" };
  }
  if (parsed.plans.length > LEGACY_OVERFLOW_MAX_PLAN_COUNT) {
    return { kind: "invalid", reason: "legacy_overflow_plan_count_oversized" };
  }
  const plans = parsed.plans.map((plan) => normalizeCachedOverflowPlan(plan, 0));
  if (plans.some((plan) => plan == null)) {
    return { kind: "invalid", reason: "legacy_overflow_plan_invalid" };
  }
  const identities = new Set<string>();
  for (const plan of plans as OverflowPlannedSubscriberAlert[]) {
    if (identities.has(plan.chatId)) {
      return { kind: "invalid", reason: "legacy_overflow_duplicate_chat" };
    }
    identities.add(plan.chatId);
  }
  const writtenAt = finiteNumber(parsed.writtenAt);
  return {
    kind: "ok",
    plans: plans as OverflowPlannedSubscriberAlert[],
    writtenAt: writtenAt == null ? null : Math.floor(writtenAt),
  };
}

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
