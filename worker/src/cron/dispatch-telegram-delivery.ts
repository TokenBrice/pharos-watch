import {
  enqueuePendingAlerts,
  pendingBackoffSec,
  setTelegramGlobalBackoff,
  type PendingDrainResult,
} from "./telegram-pending-queue";
import {
  deliverFreshAlerts,
  emptyPerAlertTypeDelivery,
  expandSubscriberChunks,
  splitFreshQueue,
  type RoutedSubscriberAlert,
} from "./dispatch-telegram-routing";
import type { PerAlertTypeDelivery } from "@shared/types/status";

interface DeliverTelegramSubscriberQueueOptions {
  db: D1Database;
  subscriberQueue: RoutedSubscriberAlert[];
  botToken: string;
  drainResult: PendingDrainResult;
  maxMessagesPerRun: number;
  nowSec: number;
  chatsInBackoff: ReadonlyMap<string, number>;
  globalBackoffUntil: number | null;
  dispatchStartedAtMs: number;
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
}

export async function deliverTelegramSubscriberQueue({
  db,
  subscriberQueue,
  botToken,
  drainResult,
  maxMessagesPerRun,
  nowSec,
  chatsInBackoff,
  globalBackoffUntil,
  dispatchStartedAtMs,
  signal,
}: DeliverTelegramSubscriberQueueOptions): Promise<DeliverTelegramSubscriberQueueResult> {
  if (globalBackoffUntil != null && globalBackoffUntil > nowSec) {
    const pendingMessages = expandSubscriberChunks(subscriberQueue);
    const perAlertType = emptyPerAlertTypeDelivery();
    for (const sub of subscriberQueue) {
      perAlertType[sub.alertType].enqueued += sub.chunks.length;
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
      freshOverflow: pendingMessages.length,
      freshDeferredPerChat: 0,
      pendingEnqueued: pendingMessages.length,
      cappedAtLimit: false,
      perAlertType,
    };
  }

  const freshBudget = Math.max(0, maxMessagesPerRun - drainResult.attempted);
  const { toSend, toEnqueue, deferredPerChat } = splitFreshQueue(
    subscriberQueue,
    freshBudget,
    chatsInBackoff,
  );
  const sendList = expandSubscriberChunks(toSend);
  const {
    subscribersNotified,
    freshSent,
    freshPermanentFailures,
    blockedUsersCleanedUp,
    blockedUsersCleanupFailed,
    blockedChats,
    retryableFreshMessages,
    perAlertType,
  } = await deliverFreshAlerts(
    db,
    sendList,
    toSend,
    botToken,
    drainResult.blockedCleanedUp,
    drainResult.blockedCleanupFailed,
    dispatchStartedAtMs,
    signal,
  );
  const deferredChats = new Set(deferredPerChat.map((sub) => sub.chatId));
  const capacityOverflow = toEnqueue.filter((sub) => !deferredChats.has(sub.chatId));
  const overflowMessages = expandSubscriberChunks(capacityOverflow, blockedChats);

  // Attribute capacity-overflow enqueues to each subscriber's dominant alert
  // type. Retry-queued enqueues were already counted inside deliverFreshAlerts
  // since they are per-chunk and tagged on the BatchMessage.
  for (const sub of capacityOverflow) {
    if (blockedChats.has(sub.chatId)) continue;
    perAlertType[sub.alertType].enqueued += sub.chunks.length;
  }

  if (overflowMessages.length > 0) {
    await enqueuePendingAlerts(db, overflowMessages, nowSec, {});
  }

  for (const deferred of deferredPerChat) {
    if (blockedChats.has(deferred.chatId)) continue;
    perAlertType[deferred.alertType].enqueued += deferred.chunks.length;
    const deferredMessages = expandSubscriberChunks([deferred], blockedChats);
    await enqueuePendingAlerts(db, deferredMessages, nowSec, {
      notBeforeAt: chatsInBackoff.get(deferred.chatId) ?? null,
    });
  }

  let globalRateLimitNotBeforeAt: number | null = null;
  for (const retry of retryableFreshMessages) {
    const retryAfterSec = retry.result.retryAfterSec;
    // Fresh sends entering the pending queue start at attempts=0; honor Retry-After when provided.
    const notBeforeAt = nowSec + pendingBackoffSec(0, retryAfterSec);
    if (retry.result.errorClass === "rate_limit" && retry.result.rateLimitScope === "global") {
      globalRateLimitNotBeforeAt = Math.max(globalRateLimitNotBeforeAt ?? 0, notBeforeAt);
    }
    await enqueuePendingAlerts(db, [retry.message], nowSec, {
      notBeforeAt: retry.result.errorClass === "rate_limit" && retry.result.rateLimitScope === "global"
        ? null
        : notBeforeAt,
      lastErrorClass: retry.result.errorClass,
      retryAfterSec,
    });
  }
  await setTelegramGlobalBackoff(db, globalRateLimitNotBeforeAt);

  const cappedOverflow = toEnqueue.length - deferredPerChat.length;

  return {
    subscribersNotified,
    freshSent,
    freshPermanentFailures,
    blockedUsersCleanedUp,
    blockedUsersCleanupFailed,
    freshAttempted: sendList.length,
    freshRetryQueued: retryableFreshMessages.length,
    freshOverflow: overflowMessages.length,
    freshDeferredPerChat: deferredPerChat.length,
    pendingEnqueued: overflowMessages.length + deferredPerChat.reduce((sum, sub) => sum + sub.chunks.length, 0) + retryableFreshMessages.length,
    cappedAtLimit: cappedOverflow > 0,
    perAlertType,
  };
}
