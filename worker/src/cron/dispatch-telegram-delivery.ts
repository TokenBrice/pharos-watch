import {
  enqueuePendingAlerts,
  type PendingDrainResult,
} from "./telegram-pending-queue";
import {
  deliverFreshAlerts,
  expandSubscriberChunks,
  splitFreshQueue,
  type RoutedSubscriberAlert,
} from "./dispatch-telegram-routing";

interface DeliverTelegramSubscriberQueueOptions {
  db: D1Database;
  subscriberQueue: RoutedSubscriberAlert[];
  botToken: string;
  drainResult: PendingDrainResult;
  maxMessagesPerRun: number;
  nowSec: number;
  chatsInBackoff: ReadonlySet<string>;
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
}

export async function deliverTelegramSubscriberQueue({
  db,
  subscriberQueue,
  botToken,
  drainResult,
  maxMessagesPerRun,
  nowSec,
  chatsInBackoff,
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
  } = await deliverFreshAlerts(
    db,
    sendList,
    toSend,
    botToken,
    drainResult.blocked - drainResult.blockedCleanupFailed,
    drainResult.blockedCleanupFailed,
    signal,
  );
  const overflowMessages = expandSubscriberChunks(toEnqueue, blockedChats);

  if (overflowMessages.length > 0) {
    await enqueuePendingAlerts(db, overflowMessages, nowSec, {});
  }

  for (const retry of retryableFreshMessages) {
    const retryAfterSec = retry.result.retryAfterSec;
    const notBeforeAt = nowSec + (retryAfterSec != null && retryAfterSec > 0 ? retryAfterSec : 60);
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
  };
}
