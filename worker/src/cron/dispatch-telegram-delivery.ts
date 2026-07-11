import {
  buildDedupeKey,
  enqueuePendingAlerts,
  pendingBackoffSec,
  PENDING_TTL_SEC,
  setTelegramGlobalBackoff,
  type PendingEnqueueOptions,
  type PendingDrainResult,
} from "./telegram-pending";
import { recordTelegramAlertTargetStatuses, type TelegramAlertTargetStatusUpdate } from "./telegram-alert-target-status";
import {
  deliverFreshAlerts,
  emptyPerAlertTypeDelivery,
  estimatedPlannedChunks,
  expandSubscriberChunks,
  formatPlannedSubscriber,
  splitFreshQueue,
  type AlertsByChatEntry,
  type PlannedSubscriberAlert,
  type RoutedSubscriberAlert,
  type FreshRetryEffectHandoff,
} from "./dispatch-telegram-routing";
import type { PerAlertTypeDelivery } from "@shared/types/status";
import { throwIfAborted } from "../lib/abort";
import type { BatchMessage } from "../lib/telegram";
import { buildInClause, chunkArray } from "../lib/db";
import { handoffFreshTelegramAlertTargetsToPending } from "./telegram-alert-target-effects";

interface DeliverTelegramSubscriberQueueOptions {
  db: D1Database;
  subscriberQueue: RoutedSubscriberAlert[];
  /**
   * C102 overflow tail: candidate chats beyond the per-run format budget that
   * could not be sent fresh this run. Formatted lazily here only to enqueue
   * their bodies, never on the hot fresh-send path.
   */
  overflowPlanned?: readonly PlannedSubscriberAlert[];
  overflowFormatBudget?: number;
  resolveDisableNotification?: (entry: AlertsByChatEntry) => boolean;
  botToken: string;
  drainResult: PendingDrainResult;
  maxMessagesPerRun: number;
  nowSec: number;
  chatsInBackoff: ReadonlyMap<string, number>;
  globalBackoffUntil: number | null;
  dispatchStartedAtMs: number;
  freshTargetJobIds?: ReadonlyMap<string, string>;
  terminalTargetKeys?: ReadonlySet<string>;
  signal?: AbortSignal;
  markTelegramDeliveryStarted?: () => void;
}

export interface DeliverTelegramSubscriberQueueResult {
  subscribersNotified: number;
  freshSent: number;
  freshPermanentFailures: number;
  blockedUsersCleanedUp: number;
  blockedUsersCleanupFailed: number;
  freshAttempted: number;
  freshRetryQueued: number;
  freshOverflow: number;
  freshDeferredPerChat: number;
  pendingEnqueued: number;
  cappedAtLimit: boolean;
  perAlertType: PerAlertTypeDelivery;
  remainingOverflowPlanned: PlannedSubscriberAlert[];
}

function selectOverflowPlansToFormat(
  planned: readonly PlannedSubscriberAlert[],
  formatBudget: number,
): { toFormat: PlannedSubscriberAlert[]; remaining: PlannedSubscriberAlert[] } {
  const budget = Math.max(0, Math.floor(formatBudget));
  if (planned.length === 0 || budget <= 0) {
    return { toFormat: [], remaining: [...planned] };
  }

  const toFormat: PlannedSubscriberAlert[] = [];
  const remaining: PlannedSubscriberAlert[] = [];
  let allocated = 0;
  let exhausted = false;

  for (const plan of planned) {
    if (!exhausted && (toFormat.length === 0 || allocated + plan.estimatedChunks <= budget)) {
      toFormat.push(plan);
      allocated += Math.max(1, plan.estimatedChunks);
    } else {
      exhausted = true;
      remaining.push(plan);
    }
  }

  return { toFormat, remaining };
}

function overflowSubscriberPlanKey(plan: PlannedSubscriberAlert): string {
  return `${plan.chatId}\0${plan.alertType}`;
}

type ActiveOverflowSubscriberRow = {
  chat_id: string;
  dews_active: number | null;
  depeg_active: number | null;
  safety_active: number | null;
  launch_active: number | null;
  reserve_active: number | null;
};

async function loadActiveOverflowSubscriberPlanKeys(
  db: D1Database,
  plans: readonly PlannedSubscriberAlert[],
): Promise<Set<string>> {
  const chatIds = Array.from(new Set(plans.map((plan) => plan.chatId)));
  const activePlanKeys = new Set<string>();
  if (chatIds.length === 0) return activePlanKeys;
  for (const chatIdChunk of chunkArray(chatIds)) {
    const inClause = buildInClause(chatIdChunk);
    const rows = await db
      .prepare(
        `SELECT s.chat_id,
                CASE WHEN s.global_alert_dews = 1 OR EXISTS (
                  SELECT 1 FROM telegram_subscriptions sub
                   WHERE sub.chat_id = s.chat_id AND sub.alert_dews = 1
                ) OR EXISTS (
                  SELECT 1 FROM telegram_preset_subscriptions preset
                   WHERE preset.chat_id = s.chat_id AND preset.alert_dews = 1
                ) THEN 1 ELSE 0 END AS dews_active,
                CASE WHEN s.global_alert_depeg = 1 OR EXISTS (
                  SELECT 1 FROM telegram_subscriptions sub
                   WHERE sub.chat_id = s.chat_id AND sub.alert_depeg = 1
                ) OR EXISTS (
                  SELECT 1 FROM telegram_preset_subscriptions preset
                   WHERE preset.chat_id = s.chat_id AND preset.alert_depeg = 1
                ) THEN 1 ELSE 0 END AS depeg_active,
                CASE WHEN s.global_alert_safety = 1 OR EXISTS (
                  SELECT 1 FROM telegram_subscriptions sub
                   WHERE sub.chat_id = s.chat_id AND sub.alert_safety = 1
                ) OR EXISTS (
                  SELECT 1 FROM telegram_preset_subscriptions preset
                   WHERE preset.chat_id = s.chat_id AND preset.alert_safety = 1
                ) THEN 1 ELSE 0 END AS safety_active,
                CASE WHEN s.global_alert_launch = 1 OR EXISTS (
                  SELECT 1 FROM telegram_subscriptions sub
                   WHERE sub.chat_id = s.chat_id AND sub.alert_launch = 1
                ) THEN 1 ELSE 0 END AS launch_active,
                CASE WHEN s.global_alert_reserve = 1 OR EXISTS (
                  SELECT 1 FROM telegram_subscriptions sub
                   WHERE sub.chat_id = s.chat_id AND sub.alert_reserve = 1
                ) THEN 1 ELSE 0 END AS reserve_active
           FROM telegram_subscribers s
          WHERE s.chat_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<ActiveOverflowSubscriberRow>();
    for (const row of rows.results ?? []) {
      if (row.dews_active === 1) activePlanKeys.add(`${row.chat_id}\0dews`);
      if (row.depeg_active === 1) activePlanKeys.add(`${row.chat_id}\0depeg`);
      if (row.safety_active === 1) activePlanKeys.add(`${row.chat_id}\0safety`);
      if (row.launch_active === 1) activePlanKeys.add(`${row.chat_id}\0launch`);
      if (row.reserve_active === 1) activePlanKeys.add(`${row.chat_id}\0reserve`);
    }
  }
  return activePlanKeys;
}

async function loadExistingPendingAttempts(
  db: D1Database,
  messages: readonly BatchMessage[],
  nowSec: number,
): Promise<Map<string, number>> {
  const dedupeKeys = Array.from(new Set(messages.map((message) => buildDedupeKey(message))));
  const attemptsByDedupeKey = new Map<string, number>();
  if (dedupeKeys.length === 0) return attemptsByDedupeKey;
  for (const keyChunk of chunkArray(dedupeKeys)) {
    const inClause = buildInClause(keyChunk);
    const rows = await db
      .prepare(
        `SELECT dedupe_key, attempts, created_at, expires_at
           FROM telegram_pending_alerts
          WHERE dedupe_key IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<{ dedupe_key: string; attempts: number | null; created_at: number | null; expires_at: number | null }>();
    for (const row of rows.results ?? []) {
      const createdAt = Number(row.created_at ?? 0);
      const expiresAt = Number(row.expires_at ?? createdAt + PENDING_TTL_SEC);
      const stale =
        (Number.isFinite(expiresAt) && expiresAt <= nowSec) ||
        (Number.isFinite(createdAt) && createdAt < nowSec - PENDING_TTL_SEC);
      if (stale) {
        attemptsByDedupeKey.set(row.dedupe_key, 0);
        continue;
      }
      const attempts = Number(row.attempts ?? 0);
      attemptsByDedupeKey.set(row.dedupe_key, Number.isFinite(attempts) ? Math.max(0, attempts) : 0);
    }
  }
  return attemptsByDedupeKey;
}

export async function deliverTelegramSubscriberQueue({
  db,
  subscriberQueue,
  overflowPlanned = [],
  overflowFormatBudget = 0,
  resolveDisableNotification = () => false,
  botToken,
  drainResult,
  maxMessagesPerRun,
  nowSec,
  chatsInBackoff,
  globalBackoffUntil,
  dispatchStartedAtMs,
  freshTargetJobIds = new Map(),
  terminalTargetKeys = new Set(),
  signal,
  markTelegramDeliveryStarted,
}: DeliverTelegramSubscriberQueueOptions): Promise<DeliverTelegramSubscriberQueueResult> {
  const filterTerminalMessages = (messages: BatchMessage[]): BatchMessage[] =>
    terminalTargetKeys.size === 0
      ? messages
      : messages.filter((message) => !terminalTargetKeys.has(buildDedupeKey(message)));
  const filterTerminalSubscriberChunksForOutcome = (subscribers: RoutedSubscriberAlert[]): RoutedSubscriberAlert[] =>
    terminalTargetKeys.size === 0
      ? subscribers
      : subscribers
        .map((sub) => {
          const chunks = sub.chunks.filter((chunk, chunkIndex) =>
            !terminalTargetKeys.has(buildDedupeKey({
              chatId: sub.chatId,
              html: chunk,
              canonicalHtml: sub.canonicalHtml,
              disableNotification: sub.disableNotification,
              chunkIndex,
              alertType: sub.alertType,
            }))
          );
          return chunks.length === sub.chunks.length ? sub : { ...sub, chunks };
        })
        .filter((sub) => sub.chunks.length > 0);

  if (globalBackoffUntil != null && globalBackoffUntil > nowSec) {
    const pendingMessages = filterTerminalMessages(
      expandSubscriberChunks(subscriberQueue),
    );
    const perAlertType = emptyPerAlertTypeDelivery();
    for (const message of pendingMessages) {
      if (message.alertType) (perAlertType[message.alertType] ??= { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null }).enqueued += 1;
    }
    if (pendingMessages.length > 0) {
      await enqueuePendingAlerts(db, pendingMessages, nowSec, {});
    }
    return {
      subscribersNotified: 0,
      freshSent: 0,
      freshPermanentFailures: 0,
      blockedUsersCleanedUp: drainResult.blockedCleanedUp,
      blockedUsersCleanupFailed: drainResult.blockedCleanupFailed,
      freshAttempted: 0,
      freshRetryQueued: 0,
      freshOverflow: pendingMessages.length + estimatedPlannedChunks(overflowPlanned),
      freshDeferredPerChat: 0,
      pendingEnqueued: pendingMessages.length,
      cappedAtLimit: overflowPlanned.length > 0,
      perAlertType,
      remainingOverflowPlanned: [...overflowPlanned],
    };
  }

  const freshBudget = Math.max(0, maxMessagesPerRun - drainResult.attempted);
  const { toSend, toEnqueue, deferredPerChat } = splitFreshQueue(
    subscriberQueue,
    freshBudget,
    chatsInBackoff,
  );
  const sendList = filterTerminalMessages(expandSubscriberChunks(toSend));
  const toSendForDeliveryOutcome = filterTerminalSubscriberChunksForOutcome(toSend);
  let globalRateLimitNotBeforeAt: number | null = null;
  const handedOffFreshRetryTargetKeys = new Set<string>();
  if (sendList.length > 0) markTelegramDeliveryStarted?.();
  const {
    subscribersNotified,
    freshSent,
    freshPermanentFailures,
    blockedUsersCleanedUp,
    blockedUsersCleanupFailed,
    freshAttempted,
    blockedChats,
    retryableFreshMessages,
    perAlertType,
    targetStatusUpdates,
  } = await deliverFreshAlerts(
    db,
    sendList,
    toSendForDeliveryOutcome,
    botToken,
    drainResult.blockedCleanedUp,
    drainResult.blockedCleanupFailed,
    dispatchStartedAtMs,
    freshTargetJobIds,
    async (handoffs: readonly FreshRetryEffectHandoff[]) => {
      const existingAttemptsByDedupeKey = await loadExistingPendingAttempts(
        db,
        handoffs.map((handoff) => handoff.message),
        nowSec,
      );
      const pendingHandoffs = handoffs.map((handoff) => {
        const priorAttempts = existingAttemptsByDedupeKey.get(buildDedupeKey(handoff.message)) ?? 0;
        const notBeforeAt = handoff.at + pendingBackoffSec(priorAttempts, handoff.result.retryAfterSec);
        const isGlobalRateLimit =
          handoff.result.errorClass === "rate_limit" && handoff.result.rateLimitScope === "global";
        if (isGlobalRateLimit) {
          globalRateLimitNotBeforeAt = Math.max(globalRateLimitNotBeforeAt ?? 0, notBeforeAt);
        }
        return {
          ...handoff.claim,
          message: handoff.message,
          at: handoff.at,
          errorClass: handoff.result.errorClass,
          options: {
            notBeforeAt: isGlobalRateLimit ? null : notBeforeAt,
            lastErrorClass: handoff.result.errorClass,
            retryAfterSec: handoff.result.retryAfterSec,
          },
        };
      });
      await handoffFreshTelegramAlertTargetsToPending(db, pendingHandoffs, signal);
      for (const handoff of handoffs) {
        handedOffFreshRetryTargetKeys.add(buildDedupeKey(handoff.message));
      }
      await setTelegramGlobalBackoff(db, globalRateLimitNotBeforeAt);
    },
    signal,
  );
  const deferredChats = new Set(deferredPerChat.map((sub) => sub.chatId));
  const capacityOverflow = toEnqueue.filter((sub) => !deferredChats.has(sub.chatId));
  const overflowMessages = filterTerminalMessages(expandSubscriberChunks(capacityOverflow, blockedChats));
  const queuedTargetStatusUpdates: TelegramAlertTargetStatusUpdate[] = [...targetStatusUpdates];
  const pushQueuedStatuses = (messages: BatchMessage[]): void => {
    queuedTargetStatusUpdates.push(...messages.map((message) => ({
      targetKey: buildDedupeKey(message),
      status: "queued" as const,
      at: nowSec,
    })));
  };
  let deferredMessageCount = 0;

  // Attribute capacity-overflow enqueues to each subscriber's dominant alert
  // type. Retry-queued enqueues were already counted inside deliverFreshAlerts
  // since they are per-chunk and tagged on the BatchMessage.
  if (overflowMessages.length > 0) {
    await enqueuePendingAlerts(db, overflowMessages, nowSec, {});
    for (const message of overflowMessages) {
      if (message.alertType) (perAlertType[message.alertType] ??= { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null }).enqueued += 1;
    }
    pushQueuedStatuses(overflowMessages);
  }

  for (const deferred of deferredPerChat) {
    throwIfAborted(signal);
    if (blockedChats.has(deferred.chatId)) continue;
    const deferredMessages = filterTerminalMessages(expandSubscriberChunks([deferred], blockedChats));
    if (deferredMessages.length === 0) continue;
    deferredMessageCount += deferredMessages.length;
    (perAlertType[deferred.alertType] ??= { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null }).enqueued += deferredMessages.length;
    await enqueuePendingAlerts(db, deferredMessages, nowSec, {
      notBeforeAt: chatsInBackoff.get(deferred.chatId) ?? null,
    });
    pushQueuedStatuses(deferredMessages);
  }

  // C102 overflow tail: chats beyond the per-run format budget. Format only the
  // caller-granted slice; the caller persists any remaining unformatted plans.
  const {
    toFormat: overflowPlansToFormat,
    remaining: remainingOverflowPlanned,
  } = selectOverflowPlansToFormat(overflowPlanned, overflowFormatBudget);
  let overflowTailMessageCount = 0;
  const activeOverflowPlanKeys = await loadActiveOverflowSubscriberPlanKeys(db, overflowPlansToFormat);
  for (const overflowPlan of overflowPlansToFormat) {
    throwIfAborted(signal);
    if (!activeOverflowPlanKeys.has(overflowSubscriberPlanKey(overflowPlan))) continue;
    const overflow = formatPlannedSubscriber(overflowPlan, resolveDisableNotification);
    if (blockedChats.has(overflow.chatId)) continue;
    const overflowTailMessages = filterTerminalMessages(expandSubscriberChunks([overflow], blockedChats));
    if (overflowTailMessages.length === 0) continue;
    overflowTailMessageCount += overflowTailMessages.length;
    (perAlertType[overflow.alertType] ??= { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null }).enqueued += overflowTailMessages.length;
    await enqueuePendingAlerts(db, overflowTailMessages, nowSec, {
      notBeforeAt: chatsInBackoff.get(overflow.chatId) ?? null,
    });
    pushQueuedStatuses(overflowTailMessages);
  }

  const existingAttemptsByDedupeKey = await loadExistingPendingAttempts(
    db,
    retryableFreshMessages
      .filter((retry) => !handedOffFreshRetryTargetKeys.has(buildDedupeKey(retry.message)))
      .map((retry) => retry.message),
    nowSec,
  );
  const retryEnqueueGroups = new Map<string, { messages: typeof retryableFreshMessages[number]["message"][]; options: PendingEnqueueOptions }>();
  for (const retry of retryableFreshMessages) {
    if (handedOffFreshRetryTargetKeys.has(buildDedupeKey(retry.message))) continue;
    const retryAfterSec = retry.result.retryAfterSec;
    const priorAttempts = existingAttemptsByDedupeKey.get(buildDedupeKey(retry.message)) ?? 0;
    const notBeforeAt = nowSec + pendingBackoffSec(priorAttempts, retryAfterSec);
    if (retry.result.errorClass === "rate_limit" && retry.result.rateLimitScope === "global") {
      globalRateLimitNotBeforeAt = Math.max(globalRateLimitNotBeforeAt ?? 0, notBeforeAt);
    }
    const options: PendingEnqueueOptions = {
      notBeforeAt: retry.result.errorClass === "rate_limit" && retry.result.rateLimitScope === "global"
        ? null
        : notBeforeAt,
      lastErrorClass: retry.result.errorClass,
      retryAfterSec,
    };
    const groupKey = JSON.stringify([
      options.notBeforeAt ?? null,
      options.lastErrorClass ?? null,
      options.retryAfterSec ?? null,
    ]);
    const group = retryEnqueueGroups.get(groupKey);
    if (group) {
      group.messages.push(retry.message);
    } else {
      retryEnqueueGroups.set(groupKey, { messages: [retry.message], options });
    }
  }
  for (const group of retryEnqueueGroups.values()) {
    throwIfAborted(signal);
    await enqueuePendingAlerts(db, group.messages, nowSec, group.options);
  }
  await setTelegramGlobalBackoff(db, globalRateLimitNotBeforeAt);
  await recordTelegramAlertTargetStatuses(db, queuedTargetStatusUpdates);

  const remainingOverflowEstimatedChunks = estimatedPlannedChunks(remainingOverflowPlanned);
  const cappedOverflow =
    toEnqueue.length -
    deferredPerChat.length +
    overflowPlansToFormat.length +
    remainingOverflowPlanned.length;

  return {
    subscribersNotified,
    freshSent,
    freshPermanentFailures,
    blockedUsersCleanedUp,
    blockedUsersCleanupFailed,
    freshAttempted,
    freshRetryQueued: retryableFreshMessages.length,
    freshOverflow: overflowMessages.length + overflowTailMessageCount + remainingOverflowEstimatedChunks,
    freshDeferredPerChat: deferredPerChat.length,
    pendingEnqueued:
      overflowMessages.length +
      overflowTailMessageCount +
      deferredMessageCount +
      retryableFreshMessages.length,
    cappedAtLimit: cappedOverflow > 0,
    perAlertType,
    remainingOverflowPlanned,
  };
}
