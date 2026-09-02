import type { AlertSafetySourceAssessment } from "../lib/alert-safety-source-cache";
import type { AlertReserveSourceAssessment } from "../lib/alert-reserve-source-cache";
import { recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress } from "../lib/cron-progress";
import { executeSourceRecoveryQueueSidecar } from "./dispatch-telegram-queue-paths";
import {
  buildDispatchResult,
  pendingTailState,
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
  completeTelegramAlertSourceEvent,
  expireTelegramAlertSourceEvent,
  loadOldestIncompleteTelegramAlertSourceEvent,
  suppressIncomparableTelegramSafetySourceEvent,
  type TelegramAlertSourceEvent,
} from "./telegram-alert-source-events";
import { expireTelegramTargetPlanSource } from "./telegram-alert-target-plans";
import type { PendingCapacitySnapshot } from "./telegram-pending";

/**
 * Source-event and baseline lifecycle steps that run before any fanout: the
 * fanout-free baseline seed, and recovery of an oldest incomplete source event
 * (baseline-committed-before-manifest backfill and bounded source expiry).
 */

export interface SeedPathContext {
  db: D1Database;
  currentSnapshots: DispatchSnapshotState["currentSnapshots"];
  reserveSourceUnavailable: boolean;
  reserveSourceAssessment: AlertReserveSourceAssessment;
  safetySnapshotNeedsSeed: boolean;
  safetySourceAssessment: AlertSafetySourceAssessment;
  suppressedSafetyChangesAtSeed: number;
  pendingCapacityBefore: PendingCapacitySnapshot;
  chatsWithActiveSnooze: number;
  sharedState?: TelegramDispatchSharedState;
  reportProgress?: CronProgressReporter;
}

export async function executeSeedPath({
  db,
  currentSnapshots,
  reserveSourceUnavailable,
  reserveSourceAssessment,
  safetySnapshotNeedsSeed,
  safetySourceAssessment,
  suppressedSafetyChangesAtSeed,
  pendingCapacityBefore,
  chatsWithActiveSnooze,
  sharedState,
  reportProgress,
}: SeedPathContext): Promise<DispatchResult> {
  await reportCronProgress(reportProgress, {
    stage: "snapshot-seed",
    message: "Seeding Telegram alert snapshots",
    providerFamily: "d1",
    itemsDone: 0,
    itemsTotal: 5,
    metadata: {
      safetySnapshotNeedsSeed,
      suppressedSafetyChangesAtSeed,
      reserveSourceUnavailable,
      deferredTail: pendingTailState(pendingCapacityBefore),
    },
  });
  await writeSnapshots(db, currentSnapshots);
  await writePresetFailureCount(db, 0);
  await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
  const result = buildDispatchResult({
    snapshotSeeded: true,
    chatsWithActiveSnooze,
    capacity: { before: pendingCapacityBefore, after: pendingCapacityBefore },
    reserve: { assessment: reserveSourceAssessment, unavailable: reserveSourceUnavailable },
    safety: {
      assessment: safetySourceAssessment,
      suppressed: safetySourceAssessment.state !== "ok" || safetySnapshotNeedsSeed,
    },
    overrides: { suppressedSafetyChangesAtSeed },
  });
  assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityBefore });
  await reportCronProgress(reportProgress, {
    stage: "complete",
    message: "Seeded Telegram alert snapshots without fanout",
    providerFamily: "telegram-dispatch",
    itemsDone: 5,
    itemsTotal: 5,
    metadata: {
      snapshotSeeded: true,
      reserveSourceUnavailable,
      deferredTail: pendingTailState(pendingCapacityBefore),
    },
  });
  return result;
}

export type SourceEventRecoveryOutcome =
  | {
      kind: "proceed";
      sourceEvent: TelegramAlertSourceEvent | null;
      resumedSourceEvent: boolean;
    }
  | { kind: "handled"; itemCount: number; metadata: string };

export async function recoverIncompleteTelegramSourceEvent(args: {
  db: D1Database;
  botToken: string;
  nowSec: number;
  dispatchStartedAtMs: number;
  pendingCapacityBefore: PendingCapacitySnapshot;
  chatsWithActiveSnooze: number;
  snapshotState: DispatchSnapshotState;
  signal?: AbortSignal;
  sharedState?: TelegramDispatchSharedState;
  reportProgress?: CronProgressReporter;
  markTelegramDeliveryStarted?: () => void;
}): Promise<SourceEventRecoveryOutcome> {
  const {
    db,
    botToken,
    nowSec,
    dispatchStartedAtMs,
    pendingCapacityBefore,
    chatsWithActiveSnooze,
    snapshotState,
    signal,
    sharedState,
    reportProgress,
    markTelegramDeliveryStarted,
  } = args;
  const { safetySourceAssessment } = snapshotState;

  let sourceEvent = await loadOldestIncompleteTelegramAlertSourceEvent(db);
  if (sourceEvent) {
    sourceEvent = suppressIncomparableTelegramSafetySourceEvent(
      sourceEvent,
      snapshotState.currentSnapshots.safety,
    );
  }
  const resumedSourceEvent = sourceEvent != null;
  if (sourceEvent?.status === "baseline_committed") {
    const recovery = await db
      .prepare(
        `SELECT target_plan_state, target_plan_generation,
                (SELECT COUNT(*) FROM telegram_alert_job_targets target
                  WHERE target.source_event_id = telegram_alert_source_events.source_event_id
                    AND target.plan_generation = telegram_alert_source_events.target_plan_generation
                    AND target.status = 'planned') AS planned_targets
           FROM telegram_alert_source_events
          WHERE source_event_id = ?`,
      )
      .bind(sourceEvent.sourceEventId)
      .first<{ target_plan_state: string; target_plan_generation: number; planned_targets: number }>();
    if (recovery?.target_plan_state === "delivery_open" && Number(recovery.planned_targets) === 0) {
      await completeTelegramAlertSourceEvent(db, sourceEvent.sourceEventId, nowSec);
      sourceEvent = null;
    } else if (recovery?.target_plan_state !== "expired") {
      await db
        .prepare(
          `UPDATE telegram_alert_source_events
              SET target_plan_state = 'degraded',
                  last_error_class = 'baseline_committed_before_manifest_ready',
                  last_attempt_at = ?
            WHERE source_event_id = ? AND status = 'baseline_committed'
              AND target_plan_state <> 'expired'`,
        )
        .bind(nowSec, sourceEvent.sourceEventId)
        .run();
      const sidecar = await executeSourceRecoveryQueueSidecar({
        db,
        botToken,
        nowSec,
        dispatchStartedAtMs,
        pendingCapacityBefore,
        chatsWithActiveSnooze,
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveSourceAssessment: snapshotState.reserveSourceAssessment,
        safetySourceAssessment,
        signal,
        sharedState,
        markTelegramDeliveryStarted,
      });
      const result = {
        ...sidecar,
        skipped: "source-event-backfill-required" as const,
        sourceEventId: sourceEvent.sourceEventId,
      };
      return { kind: "handled", itemCount: sidecar.messagesSent, metadata: JSON.stringify(result) };
    }
  }
  if (sourceEvent && sourceEvent.expiresAt <= nowSec) {
    const planningState = await db
      .prepare(
        `SELECT target_plan_generation FROM telegram_alert_source_events
          WHERE source_event_id = ?`,
      )
      .bind(sourceEvent.sourceEventId)
      .first<{ target_plan_generation: number }>();
    const expiry = await expireTelegramTargetPlanSource(
      db,
      sourceEvent.sourceEventId,
      Number(planningState?.target_plan_generation ?? 0),
      nowSec,
    );
    if (expiry.complete) {
      await expireTelegramAlertSourceEvent(db, sourceEvent, nowSec, signal);
    }
    const sidecar = await executeSourceRecoveryQueueSidecar({
      db,
      botToken,
      nowSec,
      dispatchStartedAtMs,
      pendingCapacityBefore,
      chatsWithActiveSnooze,
      reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
      reserveSourceAssessment: snapshotState.reserveSourceAssessment,
      safetySourceAssessment,
      signal,
      sharedState,
      markTelegramDeliveryStarted,
    });
    const result = {
      ...sidecar,
      skipped: "source-event-expired" as const,
      expiredSourceEventId: sourceEvent.sourceEventId,
      expiryComplete: expiry.complete,
      expiryRemaining: expiry.remaining,
    };
    await reportCronProgress(reportProgress, {
      stage: "skipped",
      message: expiry.complete
        ? "Expired unresolved Telegram source event and advanced its stored baseline"
        : "Advanced bounded Telegram source expiry cleanup",
      providerFamily: "telegram-dispatch",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: result.skipped,
        sourceEventId: sourceEvent.sourceEventId,
      },
    });
    return { kind: "handled", itemCount: sidecar.messagesSent, metadata: JSON.stringify(result) };
  }

  return { kind: "proceed", sourceEvent, resumedSourceEvent };
}
