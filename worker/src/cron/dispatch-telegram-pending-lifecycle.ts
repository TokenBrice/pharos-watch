import { recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } from "../lib/telegram-constants";
import {
  assignSharedDispatchState,
  type TelegramDispatchSharedState,
} from "./dispatch-telegram-state";
import { readTelegramPendingCapacitySnapshot } from "../lib/telegram-pending-capacity";
import {
  archiveAgedExecutionUnknownPendingAlerts,
  cleanupExpiredPendingAlerts,
  drainPendingQueue,
  emptyDrainResult,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  type PendingCapacitySnapshot,
  type PendingDrainResult,
} from "./telegram-pending";

/**
 * The pending-outbox tail every dispatch path runs: drain due rows, archive
 * aged execution-unknown rows, expire TTL-dead rows, re-read capacity, publish
 * the snapshot to shared state, and record the Telegram circuit outcome.
 *
 * The four callers (`executeCircuitOpenQueuePath`, `executeEventlessFastPath`,
 * `executeSourceRecoveryQueueSidecar`, `executeAuthoritativeFanoutPath`) do
 * *not* agree on three points, and those disagreements are deliberate rather
 * than accidental, so each is an explicit option instead of a silent
 * unification:
 *
 * 1. **Expiry cadence** — the sidecar and the authoritative path call
 *    `cleanupExpiredPendingAlerts` unconditionally; the circuit-open and
 *    eventless paths call it only when the pre-run capacity snapshot already
 *    showed expired rows. See {@link PendingQueueLifecycleContext.cleanupExpired}.
 * 2. **Capacity-refresh basis** — two paths re-read capacity whenever any
 *    queue-visible counter moved, two only when the drain actually attempted a
 *    row. See {@link PendingQueueLifecycleContext.capacityRefreshBasis}.
 * 3. **Circuit-outcome policy** — three paths record only when the drain
 *    attempted a row; the eventless path records every run and credits an idle
 *    queue as a success. See {@link PendingQueueLifecycleContext.outcomePolicy}.
 *
 * Outcome recording is returned as a closure rather than performed inline: the
 * callers record it at different points relative to other D1 writes (snapshot
 * commits, source-event completion), and moving those writes past each other
 * would change what a mid-run failure leaves behind.
 */

/** True when any queue-visible counter moved this run. */
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

export interface PendingQueueLifecycleContext {
  db: D1Database;
  nowSec: number;
  pendingCapacityBefore: PendingCapacitySnapshot;
  /**
   * Drain result computed by the caller. The authoritative path times its own
   * drains and may run one before planning and one after, so it cannot delegate
   * the drain itself.
   */
  drainResult?: PendingDrainResult;
  /** Drain configuration when the lifecycle owns the (due-gated) drain. */
  drain?: {
    botToken: string;
    dispatchStartedAtMs: number;
    signal?: AbortSignal;
    markTelegramDeliveryStarted?: () => void;
  };
  /** Expiry cadence — see the module note; not interchangeable between paths. */
  cleanupExpired: "always" | "when-snapshot-shows-expired";
  /** Which change signal drives the post-lifecycle capacity re-read. */
  capacityRefreshBasis: "queue-changed" | "drain-attempted";
  /** Extra path-specific refresh signal OR-ed into the decision. */
  forceCapacityRefresh?: boolean;
  /** Rows the caller enqueued this run (authoritative planner handoff). */
  pendingEnqueued?: number;
  sharedState?: TelegramDispatchSharedState;
  /** Circuit-breaker recording policy — see the module note. */
  outcomePolicy: "attempted-only" | "always-crediting-idle";
}

export interface PendingQueueLifecycleResult {
  drainResult: PendingDrainResult;
  archivedExecutionUnknownCount: number;
  expiredCount: number;
  pendingCapacityAfter: PendingCapacitySnapshot;
  /** Records the Telegram circuit outcome at the caller's chosen point. */
  recordDrainOutcome: () => Promise<void>;
}

export async function runPendingQueueLifecycle(
  context: PendingQueueLifecycleContext,
): Promise<PendingQueueLifecycleResult> {
  const { db, nowSec, pendingCapacityBefore } = context;
  const pendingEnqueued = context.pendingEnqueued ?? 0;

  const drainResult = context.drainResult
    ?? (context.drain && pendingCapacityBefore.due > 0
      ? await drainPendingQueue(db, context.drain.botToken, TELEGRAM_PENDING_DRAIN_BUDGET, context.drain.signal, {
        softDeadlineAtMs: context.drain.dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
        ...(context.drain.markTelegramDeliveryStarted
          ? { markTelegramDeliveryStarted: context.drain.markTelegramDeliveryStarted }
          : {}),
      })
      : emptyDrainResult());

  const archivedExecutionUnknownCount = await archiveAgedExecutionUnknownPendingAlerts(db, nowSec);
  const expiredCount =
    context.cleanupExpired === "always" || pendingCapacityBefore.expired > 0
      ? await cleanupExpiredPendingAlerts(db, nowSec)
      : 0;

  const changed = context.capacityRefreshBasis === "queue-changed"
    ? pendingQueueChanged(drainResult, expiredCount, pendingEnqueued)
    : drainResult.attempted > 0;
  const shouldRefresh =
    context.forceCapacityRefresh === true ||
    archivedExecutionUnknownCount > 0 ||
    expiredCount > 0 ||
    changed;
  const pendingCapacityAfter = shouldRefresh
    ? await readTelegramPendingCapacitySnapshot(db, nowSec)
    : pendingCapacityBefore;
  assignSharedDispatchState(context.sharedState, { pendingCapacitySnapshot: pendingCapacityAfter });

  const recordDrainOutcome = async (): Promise<void> => {
    if (context.outcomePolicy === "always-crediting-idle") {
      await recordOutcome(
        db,
        CIRCUIT_SOURCE.TELEGRAM_API,
        drainResult.sent > 0
        || drainResult.blockedCleanedUp > 0
        || pendingEnqueued > 0
        || drainResult.attempted === 0,
      );
      return;
    }
    if (drainResult.attempted === 0) return;
    await recordOutcome(
      db,
      CIRCUIT_SOURCE.TELEGRAM_API,
      drainResult.sent > 0 || drainResult.blockedCleanedUp > 0,
    );
  };

  return {
    drainResult,
    archivedExecutionUnknownCount,
    expiredCount,
    pendingCapacityAfter,
    recordDrainOutcome,
  };
}
