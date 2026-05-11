import {
  enqueuePendingAlerts,
  pendingBackoffSec,
  type PendingDrainResult,
} from "./telegram-pending-queue";
import {
  deliverFreshAlerts,
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
  chatsInBackoff: ReadonlySet<string>;
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
  dispatchStartedAtMs,
  signal,
}: DeliverTelegramSubscriberQueueOptions): Promise<DeliverTelegramSubscriberQueueResult> {
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
    drainResult.blocked - drainResult.blockedCleanupFailed,
    drainResult.blockedCleanupFailed,
    dispatchStartedAtMs,
    signal,
  );
  const overflowMessages = expandSubscriberChunks(toEnqueue, blockedChats);

  // Attribute capacity-overflow enqueues to each subscriber's dominant alert
  // type. Retry-queued enqueues were already counted inside deliverFreshAlerts
  // since they are per-chunk and tagged on the BatchMessage.
  for (const sub of toEnqueue) {
    if (blockedChats.has(sub.chatId)) continue;
    perAlertType[sub.alertType].enqueued += sub.chunks.length;
  }

  if (overflowMessages.length > 0) {
    await enqueuePendingAlerts(db, overflowMessages, nowSec, {});
  }

  for (const retry of retryableFreshMessages) {
    const retryAfterSec = retry.result.retryAfterSec;
    // Fresh sends entering the pending queue start at attempts=0; honor Retry-After when provided.
    const notBeforeAt = nowSec + pendingBackoffSec(0, retryAfterSec);
    await enqueuePendingAlerts(db, [retry.message], nowSec, {
      notBeforeAt,
      lastErrorClass: retry.result.errorClass,
      retryAfterSec,
    });
  }

  const cappedOverflow = toEnqueue.length - deferredPerChat.length;

  return {
    subscribersNotified,
    freshSent,
    freshPermanentFailures,
    blockedUsersCleanedUp,
    blockedUsersCleanupFailed,
    freshAttempted: sendList.length,
    freshRetryQueued: retryableFreshMessages.length,
    freshDeferredPerChat: deferredPerChat.length,
    pendingEnqueued: overflowMessages.length + retryableFreshMessages.length,
    cappedAtLimit: cappedOverflow > 0,
    perAlertType,
  };
}
