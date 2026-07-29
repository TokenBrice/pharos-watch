import type { AlertSafetySourceAssessment } from "../lib/alert-safety-source-cache";
import type { AlertReserveSourceAssessment } from "../lib/alert-reserve-source-cache";
import { recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import type { CronProgressReporter } from "../lib/cron-logger";
import { TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } from "../lib/telegram-constants";
import { reportDigestProgress } from "./digest/progress";
import { pendingCapacityFields } from "./dispatch-telegram-alerts-fanout";
import {
  emptyResult,
  pendingDispatchFields,
  pendingTailState,
  reserveSourceFields,
  safetySourceFields,
  type DispatchResult,
} from "./dispatch-telegram-result";
import {
  assignSharedDispatchState,
  writePresetFailureCount,
  type DispatchSnapshotState,
  type TelegramDispatchSharedState,
} from "./dispatch-telegram-state";
import { writeSnapshots } from "./telegram-alert-snapshots";
import {
  drainPendingQueue,
  archiveAgedExecutionUnknownPendingAlerts,
  cleanupExpiredPendingAlerts,
  emptyDrainResult,
  readPendingCapacitySnapshot,
  type PendingDrainResult,
  type PendingCapacitySnapshot,
  TELEGRAM_PENDING_DRAIN_BUDGET,
} from "./telegram-pending";

/**
 * Dispatch paths that run without a fresh fanout: they keep the pending-outbox
 * lifecycle moving (due-row drain, execution-unknown archival, TTL expiry) and,
 * on eventless runs, advance the stored baseline snapshots.
 */

function pendingQueueChanged(
  drainResult: PendingDrainResult,
  expiredCount: number,
  pendingEnqueued = 0,
): boolean {
  return (
    drainResult.sent > 0 ||
    drainResult.blocked > 0 ||
    drainResult.retryQueued > 0 ||
    drainResult.executionUnknown > 0 ||
    drainResult.dropped > 0 ||
    drainResult.deferred > 0 ||
    expiredCount > 0 ||
    pendingEnqueued > 0
  );
}

function pendingCountTotals(drainResult: PendingDrainResult) {
  return {
    pendingAttempted: drainResult.attempted,
    pendingSent: drainResult.sent,
    pendingDeferred: drainResult.deferred,
    pendingDropped: drainResult.dropped,
  };
}

async function readPendingCapacityAfterLifecycle(
  db: D1Database,
  nowSec: number,
  pendingCapacityBefore: PendingCapacitySnapshot,
  drainResult: PendingDrainResult,
  expiredCount: number,
  options: {
    pendingEnqueued?: number;
    forceRefresh?: boolean;
  } = {},
): Promise<PendingCapacitySnapshot> {
  const shouldRefresh =
    options.forceRefresh === true ||
    pendingQueueChanged(drainResult, expiredCount, options.pendingEnqueued ?? 0);
  return shouldRefresh
    ? readPendingCapacitySnapshot(db, nowSec)
    : pendingCapacityBefore;
}

export interface EventlessFastPathContext {
  db: D1Database;
  botToken: string;
  currentSnapshots: DispatchSnapshotState["currentSnapshots"];
  reserveSourceUnavailable: boolean;
  reserveSourceAssessment: AlertReserveSourceAssessment;
  safetySourceAssessment: AlertSafetySourceAssessment;
  safetySnapshotNeedsSeed: boolean;
  suppressedMethodologyChanges: number;
  suppressedSafetyChangesAtSeed: number;
  pendingCapacityBefore: PendingCapacitySnapshot;
  nowSec: number;
  dispatchStartedAtMs: number;
  chatsWithActiveSnooze: number;
  signal?: AbortSignal;
  sharedState?: TelegramDispatchSharedState;
  reportProgress?: CronProgressReporter;
  markTelegramDeliveryStarted?: () => void;
}

export interface CircuitOpenQueuePathContext {
  db: D1Database;
  botToken: string;
  nowSec: number;
  dispatchStartedAtMs: number;
  signal?: AbortSignal;
  sharedState?: TelegramDispatchSharedState;
  reportProgress?: CronProgressReporter;
}

export async function executeCircuitOpenQueuePath({
  db,
  botToken,
  nowSec,
  dispatchStartedAtMs,
  signal,
  sharedState,
  reportProgress,
}: CircuitOpenQueuePathContext): Promise<DispatchResult & { skipped: "circuit-open" }> {
  const pendingCapacityBefore = await readPendingCapacitySnapshot(db, nowSec);
  assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityBefore });
  await reportDigestProgress(reportProgress, {
    stage: "pending-drain",
    message: "Draining due Telegram pending rows while fresh fanout is circuit-gated",
    providerFamily: "telegram-api",
    itemsDone: 0,
    itemsTotal: Math.max(pendingCapacityBefore.due, 1),
    metadata: {
      skipped: "circuit-open",
      deferredTail: pendingTailState(pendingCapacityBefore),
    },
  });

  const drainResult = pendingCapacityBefore.due > 0
    ? await drainPendingQueue(db, botToken, TELEGRAM_PENDING_DRAIN_BUDGET, signal, {
      softDeadlineAtMs: dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
    })
    : emptyDrainResult();
  const archivedExecutionUnknownCount = await archiveAgedExecutionUnknownPendingAlerts(db, nowSec);
  const expiredCount = pendingCapacityBefore.expired > 0
    ? await cleanupExpiredPendingAlerts(db, nowSec)
    : 0;
  const pendingCapacityAfter = await readPendingCapacityAfterLifecycle(
    db,
    nowSec,
    pendingCapacityBefore,
    drainResult,
    expiredCount,
    { forceRefresh: archivedExecutionUnknownCount > 0 },
  );
  assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityAfter });

  const base = emptyResult(false);
  const result: DispatchResult & { skipped: "circuit-open" } = {
    ...base,
    skipped: "circuit-open",
    messagesSent: drainResult.sent,
    blockedUsersCleanedUp: drainResult.blockedCleanedUp,
    blockedUsersCleanupFailed: drainResult.blockedCleanupFailed,
    ...pendingDispatchFields(drainResult, { expiredCount }),
    ...pendingCapacityFields(pendingCapacityAfter),
    pendingCapacityBefore,
    pendingCapacityAfter,
  };

  if (drainResult.attempted > 0) {
    const hasSuccessfulTelegramEffect = drainResult.sent > 0 || drainResult.blockedCleanedUp > 0;
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, hasSuccessfulTelegramEffect);
  }

  await reportDigestProgress(reportProgress, {
    stage: "complete",
    message: "Skipped fresh Telegram fanout while preserving pending queue lifecycle",
    providerFamily: "telegram-dispatch",
    itemsDone: drainResult.attempted,
    itemsTotal: Math.max(pendingCapacityBefore.due, drainResult.attempted, 1),
    metadata: {
      skipped: "circuit-open",
      countTotals: pendingCountTotals(drainResult),
      deferredTail: pendingTailState(pendingCapacityAfter),
    },
  });

  return result;
}

export async function executeEventlessFastPath({
  db,
  botToken,
  currentSnapshots,
  reserveSourceUnavailable,
  reserveSourceAssessment,
  safetySourceAssessment,
  safetySnapshotNeedsSeed,
  suppressedMethodologyChanges,
  suppressedSafetyChangesAtSeed,
  pendingCapacityBefore,
  nowSec,
  dispatchStartedAtMs,
  chatsWithActiveSnooze,
  signal,
  sharedState,
  reportProgress,
  markTelegramDeliveryStarted,
}: EventlessFastPathContext): Promise<DispatchResult> {
  await reportDigestProgress(reportProgress, {
    stage: "pending-drain",
    message: "Draining due Telegram pending rows on eventless run",
    providerFamily: "telegram-api",
    itemsDone: 0,
    itemsTotal: Math.max(pendingCapacityBefore.due, 1),
    metadata: {
      eventlessFastPath: true,
      deferredTail: pendingTailState(pendingCapacityBefore),
    },
  });
  let drainResult = emptyDrainResult();
  if (pendingCapacityBefore.due > 0) {
    drainResult = await drainPendingQueue(db, botToken, TELEGRAM_PENDING_DRAIN_BUDGET, signal, {
      softDeadlineAtMs: dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
      markTelegramDeliveryStarted,
    });
  }
  const archivedExecutionUnknownCount = await archiveAgedExecutionUnknownPendingAlerts(db, nowSec);
  const expiredCount = pendingCapacityBefore.expired > 0
    ? await cleanupExpiredPendingAlerts(db, nowSec)
    : 0;
  const pendingCapacityAfter = await readPendingCapacityAfterLifecycle(
    db,
    nowSec,
    pendingCapacityBefore,
    drainResult,
    expiredCount,
    {
      forceRefresh: pendingCapacityBefore.due > 0 || pendingCapacityBefore.expired > 0 || archivedExecutionUnknownCount > 0,
    },
  );
  assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityAfter });

  await writeSnapshots(db, currentSnapshots);
  await writePresetFailureCount(db, 0);

  const base = emptyResult(false, chatsWithActiveSnooze);
  const result: DispatchResult = {
    ...base,
    eventsDetected: { ...base.eventsDetected, suppressedMethodologyChanges },
    messagesSent: drainResult.sent,
    blockedUsersCleanedUp: drainResult.blockedCleanedUp,
    blockedUsersCleanupFailed: drainResult.blockedCleanupFailed,
    ...pendingDispatchFields(drainResult, { expiredCount }),
    reserveSourceUnavailable,
    ...reserveSourceFields(reserveSourceAssessment),
    ...pendingCapacityFields(pendingCapacityAfter),
    pendingCapacityBefore,
    pendingCapacityAfter,
    chatsWithActiveSnooze,
    ...safetySourceFields(
      safetySourceAssessment,
      safetySourceAssessment.state !== "ok" || safetySnapshotNeedsSeed,
    ),
    suppressedSafetyChangesAtSeed,
    eventlessFastPath: true,
  };

  const hasSuccessfulEffect =
    result.messagesSent > 0 ||
    result.blockedUsersCleanedUp > 0 ||
    result.pendingEnqueued > 0 ||
    result.pendingAttempted === 0;
  await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, hasSuccessfulEffect);
  await reportDigestProgress(reportProgress, {
    stage: "complete",
    message: "Completed eventless Telegram dispatch",
    providerFamily: "telegram-dispatch",
    itemsDone: drainResult.attempted,
    itemsTotal: Math.max(pendingCapacityBefore.due, drainResult.attempted, 1),
    metadata: {
      eventlessFastPath: true,
      countTotals: pendingCountTotals(drainResult),
      deferredTail: pendingTailState(pendingCapacityAfter),
    },
  });
  return result;
}

export async function executeSourceRecoveryQueueSidecar(args: {
  db: D1Database;
  botToken: string;
  nowSec: number;
  dispatchStartedAtMs: number;
  pendingCapacityBefore: PendingCapacitySnapshot;
  chatsWithActiveSnooze: number;
  reserveSourceUnavailable: boolean;
  reserveSourceAssessment: AlertReserveSourceAssessment;
  safetySourceAssessment: AlertSafetySourceAssessment;
  signal?: AbortSignal;
  sharedState?: TelegramDispatchSharedState;
  markTelegramDeliveryStarted?: () => void;
}): Promise<DispatchResult> {
  const drainResult = args.pendingCapacityBefore.due > 0
    ? await drainPendingQueue(args.db, args.botToken, TELEGRAM_PENDING_DRAIN_BUDGET, args.signal, {
      softDeadlineAtMs: args.dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
      markTelegramDeliveryStarted: args.markTelegramDeliveryStarted,
    })
    : emptyDrainResult();
  const archivedUnknown = await archiveAgedExecutionUnknownPendingAlerts(args.db, args.nowSec);
  const expiredCount = await cleanupExpiredPendingAlerts(args.db, args.nowSec);
  const pendingCapacityAfter =
    drainResult.attempted > 0 || archivedUnknown > 0 || expiredCount > 0
      ? await readPendingCapacitySnapshot(args.db, args.nowSec)
      : args.pendingCapacityBefore;
  assignSharedDispatchState(args.sharedState, { pendingCapacitySnapshot: pendingCapacityAfter });
  if (drainResult.attempted > 0) {
    await recordOutcome(
      args.db,
      CIRCUIT_SOURCE.TELEGRAM_API,
      drainResult.sent > 0 || drainResult.blockedCleanedUp > 0,
    );
  }
  return {
    ...emptyResult(false, args.chatsWithActiveSnooze),
    messagesSent: drainResult.sent,
    subscribersNotified: drainResult.acceptedChats,
    blockedUsersCleanedUp: drainResult.blockedCleanedUp,
    blockedUsersCleanupFailed: drainResult.blockedCleanupFailed,
    ...pendingDispatchFields(drainResult, { expiredCount }),
    ...pendingCapacityFields(pendingCapacityAfter),
    pendingCapacityBefore: args.pendingCapacityBefore,
    pendingCapacityAfter,
    reserveSourceUnavailable: args.reserveSourceUnavailable,
    ...reserveSourceFields(args.reserveSourceAssessment),
    ...safetySourceFields(args.safetySourceAssessment, args.safetySourceAssessment.state !== "ok"),
  };
}
