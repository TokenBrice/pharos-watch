import { isRecord, numberValue as finiteNumber } from "@shared/lib/type-guards";
import { isTelegramAlertType } from "@shared/types/status";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import { getCache, setCache } from "../lib/db-cache";
import {
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
} from "../lib/telegram-constants";
import { deliverTelegramSubscriberQueue, type DeliverTelegramSubscriberQueueResult } from "./dispatch-telegram-delivery";
import {
  estimatedPlannedChunks,
  formatPlannedSubscribers,
  planSubscriberQueue,
  selectChatsToFormat,
  type AlertsByChatEntry,
  type PlannedSubscriberAlert,
  type RoutedSubscriberAlert,
} from "./dispatch-telegram-routing";
import { hasEscalation } from "./dispatch-telegram-predicates";
import { isQuietHoursActive } from "./telegram-quiet-hours";
import {
  loadChatsInBackoff,
  readTelegramGlobalBackoff,
  type PendingDrainResult,
} from "./telegram-pending";
import { isValidPendingSourceEventId } from "../lib/telegram-pending-provenance";
import { OVERFLOW_PLAN_CACHE_KEY } from "../lib/telegram-overflow-plan-cache";

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

export async function readOverflowPlanBacklog(
  db: D1Database,
  nowSec: number,
): Promise<OverflowPlannedSubscriberAlert[]> {
  const cached = await getCache(db, OVERFLOW_PLAN_CACHE_KEY);
  if (!cached) return [];
  const parsed = parseLegacyOverflowPlanBacklog(cached.value);
  return parsed.kind === "ok" ? parsed.plans.filter((plan) => plan.expiresAt > nowSec) : [];
}

function withOverflowPlanExpiry(plan: PlannedSubscriberAlert, nowSec: number): OverflowPlannedSubscriberAlert {
  const existingExpiresAt = finiteNumber((plan as OverflowPlannedSubscriberAlert).expiresAt);
  return {
    ...plan,
    expiresAt: existingExpiresAt != null
      ? Math.floor(existingExpiresAt)
      : nowSec + TELEGRAM_ALERT_TTL_SEC[plan.alertType],
  };
}

async function writeOverflowPlanBacklog(
  db: D1Database,
  plans: readonly PlannedSubscriberAlert[],
  nowSec: number,
  shouldWrite: boolean,
): Promise<void> {
  if (!shouldWrite) return;
  await setCache(
    db,
    OVERFLOW_PLAN_CACHE_KEY,
    JSON.stringify({
      version: OVERFLOW_PLAN_CACHE_VERSION,
      writtenAt: nowSec,
      plans: plans.map((plan) => withOverflowPlanExpiry(plan, nowSec)),
    }),
  );
}

export async function drainOverflowBacklogOnly(args: {
  db: D1Database;
  botToken: string;
  overflowBacklog: readonly PlannedSubscriberAlert[];
  drainResult: PendingDrainResult;
  nowSec: number;
  signal?: AbortSignal;
  markTelegramDeliveryStarted?: () => void;
}): Promise<DeliverTelegramSubscriberQueueResult | null> {
  if (args.overflowBacklog.length === 0) return null;
  const [chatsInBackoff, globalBackoffUntil] = await Promise.all([
    loadChatsInBackoff(args.db, args.nowSec),
    readTelegramGlobalBackoff(args.db, args.nowSec),
  ]);
  return deliverTelegramSubscriberQueue({
    db: args.db,
    botToken: args.botToken,
    subscriberQueue: [],
    overflowPlanned: args.overflowBacklog,
    overflowFormatBudget: TELEGRAM_MAX_MESSAGES_PER_RUN + TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
    drainResult: args.drainResult,
    maxMessagesPerRun: TELEGRAM_MAX_MESSAGES_PER_RUN,
    nowSec: args.nowSec,
    chatsInBackoff,
    globalBackoffUntil,
    dispatchStartedAtMs: Date.now(),
    signal: args.signal,
    markTelegramDeliveryStarted: args.markTelegramDeliveryStarted,
  });
}

export async function persistEventlessOverflowBacklog(
  db: D1Database,
  result: DeliverTelegramSubscriberQueueResult | null,
  overflowBacklog: readonly PlannedSubscriberAlert[],
  nowSec: number,
): Promise<void> {
  if (!result) return;
  await writeOverflowPlanBacklog(
    db,
    result.remainingOverflowPlanned,
    nowSec,
    result.pendingEnqueued > 0 ||
      result.remainingOverflowPlanned.length !== overflowBacklog.length,
  );
}

function splitFreshPlansForOverflowPriority(
  plannedQueue: readonly PlannedSubscriberAlert[],
  overflowBacklog: readonly PlannedSubscriberAlert[],
  formatBudget: number,
): {
  toFormat: PlannedSubscriberAlert[];
  overflowPlanned: PlannedSubscriberAlert[];
  overflowFormatBudget: number;
} {
  const overflowFormatBudget = Math.min(formatBudget, estimatedPlannedChunks(overflowBacklog));
  const freshFormatBudget = Math.max(0, formatBudget - overflowFormatBudget);
  const { toFormat, overflow } = freshFormatBudget > 0
    ? selectChatsToFormat(plannedQueue, freshFormatBudget)
    : { toFormat: [], overflow: [...plannedQueue] };
  return { toFormat, overflowPlanned: overflow, overflowFormatBudget };
}

export function buildOverflowAwareSubscriberQueue(args: {
  alertsByChat: Map<string, AlertsByChatEntry>;
  overflowBacklog: readonly PlannedSubscriberAlert[];
  nowSec: number;
  formatBudget: number;
  sourceEventId?: string;
  safetyScoreIdentity?: SafetyScorePublicationIdentity | null;
}): {
  plannedQueue: PlannedSubscriberAlert[];
  subscriberQueue: RoutedSubscriberAlert[];
  overflowPlanned: PlannedSubscriberAlert[];
  combinedOverflowPlanned: PlannedSubscriberAlert[];
  overflowFormatBudget: number;
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
  const { toFormat, overflowPlanned, overflowFormatBudget } = splitFreshPlansForOverflowPriority(
    plannedQueue,
    args.overflowBacklog,
    args.formatBudget,
  );
  const subscriberQueue = formatPlannedSubscribers(toFormat, resolveDisableNotification);
  return {
    plannedQueue,
    subscriberQueue,
    overflowPlanned,
    combinedOverflowPlanned: [...args.overflowBacklog, ...overflowPlanned],
    overflowFormatBudget,
    resolveDisableNotification,
  };
}

export async function persistFanoutOverflowBacklog(
  db: D1Database,
  remainingOverflowPlanned: readonly PlannedSubscriberAlert[],
  overflowBacklog: readonly PlannedSubscriberAlert[],
  overflowPlanned: readonly PlannedSubscriberAlert[],
  nowSec: number,
): Promise<void> {
  await writeOverflowPlanBacklog(
    db,
    remainingOverflowPlanned,
    nowSec,
    overflowBacklog.length > 0 || overflowPlanned.length > 0,
  );
}
