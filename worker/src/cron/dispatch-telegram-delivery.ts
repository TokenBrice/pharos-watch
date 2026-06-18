import {
  buildDedupeKey,
  enqueuePendingAlerts,
  pendingBackoffSec,
  setTelegramGlobalBackoff,
  type PendingEnqueueOptions,
  type PendingDrainResult,
} from "./telegram-pending";
import { recordTelegramAlertTargetStatuses, type TelegramAlertTargetStatusUpdate } from "./telegram-alert-target-status";
import {
  deliverFreshAlerts,
  emptyPerAlertTypeDelivery,
  expandSubscriberChunks,
  formatPlannedSubscriber,
  splitFreshQueue,
  type AlertsByChatEntry,
  type PlannedSubscriberAlert,
  type RoutedSubscriberAlert,
} from "./dispatch-telegram-routing";
import type { PerAlertTypeDelivery } from "@shared/types/status";
import { throwIfAborted } from "../lib/abort";
import type { BatchMessage } from "../lib/telegram";
import { buildInClause, chunkArray } from "../lib/db";

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
  terminalTargetKeys?: ReadonlySet<string>;
  signal?: AbortSignal;
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

function estimatedPlannedChunks(plans: readonly PlannedSubscriberAlert[]): number {
  return plans.reduce((sum, plan) => sum + Math.max(1, plan.estimatedChunks), 0);
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

async function loadExistingPendingAttempts(
  db: D1Database,
  messages: readonly BatchMessage[],
): Promise<Map<string, number>> {
  const dedupeKeys = Array.from(new Set(messages.map((message) => buildDedupeKey(message))));
  const attemptsByDedupeKey = new Map<string, number>();
  if (dedupeKeys.length === 0) return attemptsByDedupeKey;
  for (const keyChunk of chunkArray(dedupeKeys)) {
    const inClause = buildInClause(keyChunk);
    const rows = await db
      .prepare(
        `SELECT dedupe_key, attempts
           FROM telegram_pending_alerts
          WHERE dedupe_key IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<{ dedupe_key: string; attempts: number | null }>();
    for (const row of rows.results ?? []) {
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
  terminalTargetKeys = new Set(),
  signal,
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
      if (message.alertType) perAlertType[message.alertType].enqueued += 1;
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
    signal,
  );
  const deferredChats = new Set(deferredPerChat.map((sub) => sub.chatId));
  const capacityOverflow = toEnqueue.filter((sub) => !deferredChats.has(sub.chatId));
  const overflowMessages = filterTerminalMessages(expandSubscriberChunks(capacityOverflow, blockedChats));
  const queuedTargetStatusUpdates: TelegramAlertTargetStatusUpdate[] = [...targetStatusUpdates];
  let deferredMessageCount = 0;

  // Attribute capacity-overflow enqueues to each subscriber's dominant alert
  // type. Retry-queued enqueues were already counted inside deliverFreshAlerts
  // since they are per-chunk and tagged on the BatchMessage.
  if (overflowMessages.length > 0) {
    await enqueuePendingAlerts(db, overflowMessages, nowSec, {});
    for (const message of overflowMessages) {
      if (message.alertType) perAlertType[message.alertType].enqueued += 1;
    }
    queuedTargetStatusUpdates.push(...overflowMessages.map((message) => ({
      targetKey: buildDedupeKey(message),
      status: "queued" as const,
      at: nowSec,
    })));
  }

  for (const deferred of deferredPerChat) {
    throwIfAborted(signal);
    if (blockedChats.has(deferred.chatId)) continue;
    const deferredMessages = filterTerminalMessages(expandSubscriberChunks([deferred], blockedChats));
    if (deferredMessages.length === 0) continue;
    deferredMessageCount += deferredMessages.length;
    perAlertType[deferred.alertType].enqueued += deferredMessages.length;
    await enqueuePendingAlerts(db, deferredMessages, nowSec, {
      notBeforeAt: chatsInBackoff.get(deferred.chatId) ?? null,
    });
    queuedTargetStatusUpdates.push(...deferredMessages.map((message) => ({
      targetKey: buildDedupeKey(message),
      status: "queued" as const,
      at: nowSec,
    })));
  }

  // C102 overflow tail: chats beyond the per-run format budget. Format only the
  // caller-granted slice; the caller persists any remaining unformatted plans.
  const {
    toFormat: overflowPlansToFormat,
    remaining: remainingOverflowPlanned,
  } = selectOverflowPlansToFormat(overflowPlanned, overflowFormatBudget);
  let overflowTailMessageCount = 0;
  for (const overflowPlan of overflowPlansToFormat) {
    throwIfAborted(signal);
    const overflow = formatPlannedSubscriber(overflowPlan, resolveDisableNotification);
    if (blockedChats.has(overflow.chatId)) continue;
    const overflowTailMessages = filterTerminalMessages(expandSubscriberChunks([overflow], blockedChats));
    if (overflowTailMessages.length === 0) continue;
    overflowTailMessageCount += overflowTailMessages.length;
    perAlertType[overflow.alertType].enqueued += overflowTailMessages.length;
    await enqueuePendingAlerts(db, overflowTailMessages, nowSec, {
      notBeforeAt: chatsInBackoff.get(overflow.chatId) ?? null,
    });
    queuedTargetStatusUpdates.push(...overflowTailMessages.map((message) => ({
      targetKey: buildDedupeKey(message),
      status: "queued" as const,
      at: nowSec,
    })));
  }

  let globalRateLimitNotBeforeAt: number | null = null;
  const existingAttemptsByDedupeKey = await loadExistingPendingAttempts(
    db,
    retryableFreshMessages.map((retry) => retry.message),
  );
  const retryEnqueueGroups = new Map<string, { messages: typeof retryableFreshMessages[number]["message"][]; options: PendingEnqueueOptions }>();
  for (const retry of retryableFreshMessages) {
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
