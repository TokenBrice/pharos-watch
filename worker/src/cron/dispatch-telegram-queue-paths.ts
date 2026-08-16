import type { AlertSafetySourceAssessment } from "../lib/alert-safety-source-cache";
import type { AlertReserveSourceAssessment } from "../lib/alert-reserve-source-cache";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress } from "../lib/cron-progress";
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
import { runPendingQueueLifecycle } from "./dispatch-telegram-pending-lifecycle";
import { readTelegramPendingCapacitySnapshot } from "../lib/telegram-pending-capacity";
import {
  type PendingDrainResult,
  type PendingCapacitySnapshot,
} from "./telegram-pending";

/**
 * Dispatch paths that run without a fresh fanout: they keep the pending-outbox
 * lifecycle moving (due-row drain, execution-unknown archival, TTL expiry) and,
 * on eventless runs, advance the stored baseline snapshots.
 */

function pendingCountTotals(drainResult: PendingDrainResult) {
  return {
    pendingAttempted: drainResult.attempted,
    pendingSent: drainResult.sent,
    pendingDeferred: drainResult.deferred,
    pendingDropped: drainResult.dropped,
  };
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
  const pendingCapacityBefore = await readTelegramPendingCapacitySnapshot(db, nowSec);
  assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityBefore });
  await reportCronProgress(reportProgress, {
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

  const lifecycle = await runPendingQueueLifecycle({
    db,
    nowSec,
    pendingCapacityBefore,
    drain: { botToken, dispatchStartedAtMs, signal },
    cleanupExpired: "when-snapshot-shows-expired",
    capacityRefreshBasis: "queue-changed",
    outcomePolicy: "attempted-only",
    sharedState,
  });
  const { drainResult, expiredCount, pendingCapacityAfter } = lifecycle;

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

  await lifecycle.recordDrainOutcome();

  await reportCronProgress(reportProgress, {
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
  await reportCronProgress(reportProgress, {
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
  const lifecycle = await runPendingQueueLifecycle({
    db,
    nowSec,
    pendingCapacityBefore,
    drain: { botToken, dispatchStartedAtMs, signal, markTelegramDeliveryStarted },
    cleanupExpired: "when-snapshot-shows-expired",
    capacityRefreshBasis: "queue-changed",
    forceCapacityRefresh: pendingCapacityBefore.due > 0 || pendingCapacityBefore.expired > 0,
    outcomePolicy: "always-crediting-idle",
    sharedState,
  });
  const { drainResult, expiredCount, pendingCapacityAfter } = lifecycle;

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

  await lifecycle.recordDrainOutcome();
  await reportCronProgress(reportProgress, {
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
  // The recovery sidecar expires TTL-dead rows on every run, unlike the
  // circuit-open/eventless paths which only do so when the pre-run snapshot
  // already showed expired rows. That difference is deliberate: the sidecar is
  // the only path that runs while the fresh lane is degraded, so it carries the
  // unconditional expiry duty.
  const lifecycle = await runPendingQueueLifecycle({
    db: args.db,
    nowSec: args.nowSec,
    pendingCapacityBefore: args.pendingCapacityBefore,
    drain: {
      botToken: args.botToken,
      dispatchStartedAtMs: args.dispatchStartedAtMs,
      signal: args.signal,
      markTelegramDeliveryStarted: args.markTelegramDeliveryStarted,
    },
    cleanupExpired: "always",
    capacityRefreshBasis: "drain-attempted",
    outcomePolicy: "attempted-only",
    sharedState: args.sharedState,
  });
  const { drainResult, expiredCount, pendingCapacityAfter } = lifecycle;
  await lifecycle.recordDrainOutcome();
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
