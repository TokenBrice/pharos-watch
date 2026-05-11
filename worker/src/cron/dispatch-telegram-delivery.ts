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
  signal,
}: DeliverTelegramSubscriberQueueOptions): Promise<DeliverTelegramSubscriberQueueResult> {
  const freshBudget = Math.max(0, maxMessagesPerRun - drainResult.attempted);
  const { toSend, toEnqueue } = drainResult.rateLimited
    ? { toSend: [], toEnqueue: subscriberQueue }
    : splitFreshQueue(subscriberQueue, freshBudget);
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
    await enqueuePendingAlerts(
      db,
      overflowMessages,
      nowSec,
      drainResult.rateLimited
        ? { notBeforeAt: drainResult.notBeforeAt, lastErrorClass: "rate_limit", retryAfterSec: drainResult.retryAfterSec }
        : {},
    );
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

  return {
    subscribersNotified,
    freshSent,
    freshPermanentFailures,
    blockedUsersCleanedUp,
    blockedUsersCleanupFailed,
    freshAttempted: sendList.length,
    freshRetryQueued: retryableFreshMessages.length,
    pendingEnqueued: overflowMessages.length + retryableFreshMessages.length,
    cappedAtLimit: toEnqueue.length > 0,
  };
}
