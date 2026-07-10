import { isRecord, numberValue as finiteNumber } from "@shared/lib/type-guards";
import { isTelegramAlertType } from "@shared/types/status";
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

const OVERFLOW_PLAN_CACHE_KEY = "telegram:dispatch-overflow-plan";
const OVERFLOW_PLAN_CACHE_VERSION = 1;

type OverflowPlannedSubscriberAlert = PlannedSubscriberAlert & { expiresAt?: number };

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

function normalizeCachedOverflowPlan(value: unknown, nowSec: number): OverflowPlannedSubscriberAlert | null {
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

  if (
    chatId == null ||
    alertType == null ||
    estimatedChunks == null ||
    expiresAt == null ||
    expiresAt <= nowSec ||
    rawEntry == null ||
    alerts == null ||
    lastActiveAt == null
  ) {
    return null;
  }

  return {
    chatId,
    alertType,
    ...(sourceEventId ? { sourceEventId } : {}),
    estimatedChunks: Math.max(1, Math.floor(estimatedChunks)),
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

export async function readOverflowPlanBacklog(
  db: D1Database,
  nowSec: number,
): Promise<OverflowPlannedSubscriberAlert[]> {
  const cached = await getCache(db, OVERFLOW_PLAN_CACHE_KEY);
  if (!cached) return [];
  try {
    const parsed = JSON.parse(cached.value) as unknown;
    if (!isRecord(parsed) || parsed.version !== OVERFLOW_PLAN_CACHE_VERSION || !Array.isArray(parsed.plans)) {
      return [];
    }
    return parsed.plans
      .map((plan) => normalizeCachedOverflowPlan(plan, nowSec))
      .filter((plan): plan is OverflowPlannedSubscriberAlert => plan != null);
  } catch {
    return [];
  }
}

export async function pruneOverflowPlanBacklogForChat(
  db: D1Database,
  chatId: string,
  nowSec: number,
): Promise<void> {
  const cached = await getCache(db, OVERFLOW_PLAN_CACHE_KEY);
  if (!cached) return;
  try {
    const parsed = JSON.parse(cached.value) as unknown;
    if (!isRecord(parsed) || parsed.version !== OVERFLOW_PLAN_CACHE_VERSION || !Array.isArray(parsed.plans)) {
      return;
    }
    const remainingPlans = parsed.plans
      .map((plan) => normalizeCachedOverflowPlan(plan, nowSec))
      .filter((plan): plan is OverflowPlannedSubscriberAlert => plan != null && plan.chatId !== chatId);
    if (remainingPlans.length === parsed.plans.length) return;
    await setCache(
      db,
      OVERFLOW_PLAN_CACHE_KEY,
      JSON.stringify({
        version: OVERFLOW_PLAN_CACHE_VERSION,
        writtenAt: nowSec,
        plans: remainingPlans,
      }),
    );
  } catch {
    return;
  }
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
  const plannedQueue = planSubscriberQueue(args.alertsByChat, args.sourceEventId);
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
