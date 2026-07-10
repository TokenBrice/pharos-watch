import type { AlertReserveSourceAssessment } from "../lib/alert-reserve-source-cache";
import type { AlertSafetySourceAssessment } from "../lib/alert-safety-source-cache";
import { recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import type { CronProgressReporter } from "../lib/cron-logger";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "../lib/stablecoins-cache";
import { createTelegramAuthoritativePlanningCallbacks } from "./dispatch-telegram-authoritative-planning";
import type { buildTelegramDispatchEvents } from "./dispatch-telegram-events";
import { pendingCapacityFields } from "./dispatch-telegram-alerts-fanout";
import { type DispatchResult, emptyResult } from "./dispatch-telegram-result";
import type { buildDispatchSnapshotState } from "./dispatch-telegram-state";
import { reportDigestProgress } from "./digest/progress";
import {
  archiveAgedExecutionUnknownPendingAlerts,
  cleanupExpiredPendingAlerts,
  drainPendingQueue,
  emptyDrainResult,
  readPendingCapacitySnapshot,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  type PendingCapacitySnapshot,
  type PendingDrainResult,
} from "./telegram-pending";
import {
  commitTelegramAlertSourceBaseline,
  completeTelegramAlertSourceEvent,
  expireTelegramAlertSourceEvent,
  markTelegramAlertSourceEventPlanned,
  resolveTelegramAlertSourcePresetPages,
  type TelegramAlertSourceEvent,
} from "./telegram-alert-source-events";
import {
  loadTelegramTargetPlanProgress,
  runTelegramTargetPlanCoordinator,
  TELEGRAM_TARGET_PLAN_MAX_STEPS_PER_RUN,
} from "./telegram-alert-target-plans";
import { TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } from "../lib/telegram-constants";
import { readTelegramFreshHandoffAllowance } from "../lib/telegram-transport-control";

type DispatchSnapshotState = ReturnType<typeof buildDispatchSnapshotState>;
type DispatchEvents = Awaited<ReturnType<typeof buildTelegramDispatchEvents>>;

export interface AuthoritativeFanoutPathContext {
  db: D1Database;
  botToken: string;
  snapshotState: DispatchSnapshotState;
  events: DispatchEvents;
  sourceEvent: TelegramAlertSourceEvent;
  suppressedSafetyChangesAtSeed: number;
  pendingCapacityBefore: PendingCapacitySnapshot;
  nowSec: number;
  dispatchStartedAtMs: number;
  chatsWithActiveSnooze: number;
  signal?: AbortSignal;
  sharedState?: { pendingCapacitySnapshot?: PendingCapacitySnapshot };
  reportProgress?: CronProgressReporter;
  markTelegramDeliveryStarted?: () => void;
}

export interface AuthoritativeFanoutPathHooks {
  updatePresetFailureState: (failed: boolean) => Promise<void>;
}

export function hasDeferredTelegramAuthoritativeWork(
  sourceResolutionComplete: boolean,
  planner: Pick<
    Awaited<ReturnType<typeof runTelegramTargetPlanCoordinator>>,
    "state" | "remainingTargets" | "expiryComplete"
  > | null,
): boolean {
  if (!sourceResolutionComplete || !planner) return true;
  if (planner.state === "delivery_open") return planner.remainingTargets > 0;
  if (planner.state === "expired") return !planner.expiryComplete;
  return true;
}

function pendingFields(
  drain: PendingDrainResult,
  expiredCount: number,
  pendingEnqueued: number,
): Pick<
  DispatchResult,
  | "pendingAttempted"
  | "pendingDrained"
  | "pendingSent"
  | "pendingRetryQueued"
  | "pendingDropped"
  | "pendingDroppedTtlExpired"
  | "pendingDroppedPermanentFailure"
  | "pendingDroppedMaxAttemptsFallback"
  | "pendingDeferred"
  | "pendingRateLimited"
  | "pendingRetryAfterSec"
  | "pendingEnqueued"
  | "pendingExpired"
> {
  return {
    pendingAttempted: drain.attempted,
    pendingDrained: drain.sent,
    pendingSent: drain.sent,
    pendingRetryQueued: drain.retryQueued,
    pendingDropped: drain.dropped,
    pendingDroppedTtlExpired: expiredCount,
    pendingDroppedPermanentFailure: drain.droppedPermanentFailure,
    pendingDroppedMaxAttemptsFallback: drain.droppedMaxAttemptsFallback,
    pendingDeferred: drain.deferred,
    pendingRateLimited: drain.rateLimited,
    pendingRetryAfterSec: drain.retryAfterSec,
    pendingEnqueued,
    pendingExpired: expiredCount,
  };
}

function safetyFields(assessment: AlertSafetySourceAssessment, suppressed: boolean) {
  return {
    safetyAlertSourceState: assessment.state,
    safetyAlertSourceAgeSeconds: assessment.ageSeconds,
    safetyAlertsSuppressed: suppressed,
    safetyAlertSourceGeneration: assessment.generation,
  };
}

function reserveFields(assessment: AlertReserveSourceAssessment) {
  return {
    reserveAlertSourceState: assessment.state,
    reserveAlertSourceAgeSeconds: assessment.ageSeconds,
    reserveAlertsSuppressed: assessment.state !== "ok",
    reserveAlertSourceGeneration: assessment.generation,
  };
}

export async function executeAuthoritativeFanoutPath(
  context: AuthoritativeFanoutPathContext,
  hooks: AuthoritativeFanoutPathHooks,
): Promise<DispatchResult> {
  const {
    db,
    events,
    sourceEvent,
    nowSec,
    snapshotState,
  } = context;
  const fanoutStartedAtMs = Date.now();
  let cacheResult: Promise<StablecoinsCacheLoadResult> | null = null;
  const sourceResolution = await resolveTelegramAlertSourcePresetPages(db, sourceEvent, nowSec, {
    getStablecoinsCacheResult: () => {
      cacheResult ??= loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true });
      return cacheResult;
    },
    includeSubscriberMaps: false,
  });
  await hooks.updatePresetFailureState(
    sourceResolution.queryFailures > 0 || sourceResolution.resolutionFailures > 0,
  );

  let planner: Awaited<ReturnType<typeof runTelegramTargetPlanCoordinator>> | null = null;
  if (sourceResolution.allComplete) {
    const handoffAllowance = await readTelegramFreshHandoffAllowance(
      db,
      nowSec,
      Number.MAX_SAFE_INTEGER,
    );
    await markTelegramAlertSourceEventPlanned(db, sourceEvent.sourceEventId, nowSec);
    planner = await runTelegramTargetPlanCoordinator({
      db,
      sourceEventId: sourceEvent.sourceEventId,
      nowSec,
      signal: context.signal,
      maxSteps: TELEGRAM_TARGET_PLAN_MAX_STEPS_PER_RUN,
      deliveryHandoffLimit: handoffAllowance.maxTargets,
      callbacks: createTelegramAuthoritativePlanningCallbacks({
        db,
        sourceEventId: sourceEvent.sourceEventId,
        nowSec,
        events: {
          dewsChanges: events.dewsChanges,
          depegTriggered: events.depegTriggered,
          depegResolved: events.depegResolved,
          depegWorsening: events.depegWorsening,
          safetyChanges: events.safetyChanges,
          launchPromoted: events.launchPromoted,
          reservePromoted: events.reservePromoted,
        },
        stablecoinIds: {
          dewsIds: events.dewsIds,
          depegIds: events.depegIds,
          safetyIds: events.safetyIds,
          launchIds: events.launchIds,
          reserveIds: events.reserveIds,
        },
      }),
    });
  }
  const progress = await loadTelegramTargetPlanProgress(db, sourceEvent.sourceEventId);
  const fanoutMs = Math.max(0, Date.now() - fanoutStartedAtMs);
  await reportDigestProgress(context.reportProgress, {
    stage: "fanout-built",
    message: "Advanced durable Telegram target manifests",
    providerFamily: "telegram-dispatch",
    itemsDone: progress.targets,
    itemsTotal: Math.max(progress.capturedSubscribers, progress.targets, 1),
    metadata: {
      sourceEventId: sourceEvent.sourceEventId,
      plannerState: progress.state,
      plannerGeneration: progress.generation,
      planningOutcomes: progress.planningOutcomes,
      sourceResolutionPendingPages: sourceResolution.pendingPages,
      targetPlans: progress.plans,
      targetChunks: progress.targets,
    },
  });

  const drainResult = context.pendingCapacityBefore.due > 0 || (planner?.enqueued ?? 0) > 0
    ? await drainPendingQueue(db, context.botToken, TELEGRAM_PENDING_DRAIN_BUDGET, context.signal, {
      softDeadlineAtMs: context.dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
      markTelegramDeliveryStarted: context.markTelegramDeliveryStarted,
    })
    : emptyDrainResult();
  const archivedUnknown = await archiveAgedExecutionUnknownPendingAlerts(db, nowSec);
  const expiredCount = await cleanupExpiredPendingAlerts(db, nowSec);
  const pendingCapacityAfter =
    drainResult.attempted > 0 || expiredCount > 0 || archivedUnknown > 0 || (planner?.enqueued ?? 0) > 0
      ? await readPendingCapacitySnapshot(db, nowSec)
      : context.pendingCapacityBefore;
  if (context.sharedState) context.sharedState.pendingCapacitySnapshot = pendingCapacityAfter;

  if (planner?.state === "delivery_open" && planner.remainingTargets === 0) {
    await commitTelegramAlertSourceBaseline(db, sourceEvent, nowSec, context.signal);
    await completeTelegramAlertSourceEvent(db, sourceEvent.sourceEventId, nowSec);
  } else if (planner?.state === "expired" && planner.expiryComplete) {
    await expireTelegramAlertSourceEvent(db, sourceEvent, nowSec, context.signal);
  }

  const base = emptyResult(false, context.chatsWithActiveSnooze);
  const result: DispatchResult = {
    ...base,
    eventsDetected: {
      dews: events.dewsChanges.length,
      depeg: events.depegTriggered.length + events.depegResolved.length + events.depegWorsening.length,
      depegTriggered: events.depegTriggered.length,
      depegResolved: events.depegResolved.length,
      depegWorsening: events.depegWorsening.length,
      safety: events.safetyChanges.length,
      launch: events.launchPromoted.length,
      reserve: events.reservePromoted.length,
      suppressedMethodologyChanges: events.suppressedMethodologyChanges,
    },
    subscribersNotified: drainResult.acceptedChats,
    messagesSent: drainResult.sent,
    blockedUsersCleanedUp: drainResult.blockedCleanedUp,
    blockedUsersCleanupFailed: drainResult.blockedCleanupFailed,
    cappedAtLimit: hasDeferredTelegramAuthoritativeWork(sourceResolution.allComplete, planner),
    ...pendingFields(drainResult, expiredCount, planner?.enqueued ?? 0),
    ...pendingCapacityFields(pendingCapacityAfter),
    pendingCapacityBefore: context.pendingCapacityBefore,
    pendingCapacityAfter,
    freshCandidateChats: Number(progress.planningOutcomes.target_planned ?? 0),
    freshCandidateCount: progress.targets,
    freshOverflow: planner?.remainingTargets ?? 0,
    presetQueryFailures: sourceResolution.queryFailures,
    presetResolutionFailures: sourceResolution.resolutionFailures,
    presetFailure: !sourceResolution.allComplete,
    fanoutQueryMs: fanoutMs,
    fanoutBuildMs: 0,
    fanoutTotalMs: fanoutMs,
    reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
    ...reserveFields(snapshotState.reserveSourceAssessment),
    ...safetyFields(
      snapshotState.safetySourceAssessment,
      snapshotState.safetySourceAssessment.state !== "ok" || snapshotState.safetySnapshotNeedsSeed,
    ),
    suppressedSafetyChangesAtSeed: context.suppressedSafetyChangesAtSeed,
  };
  if (drainResult.attempted > 0) {
    const successfulEffect = drainResult.sent > 0 || drainResult.blockedCleanedUp > 0;
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, successfulEffect);
  }
  await reportDigestProgress(context.reportProgress, {
    stage: "complete",
    message: "Completed row-authoritative Telegram dispatch",
    providerFamily: "telegram-dispatch",
    itemsDone: drainResult.sent,
    itemsTotal: Math.max(drainResult.attempted + progress.targets, 1),
    metadata: {
      sourceEventId: sourceEvent.sourceEventId,
      plannerState: progress.state,
      pendingEnqueued: planner?.enqueued ?? 0,
      remainingTargets: planner?.remainingTargets ?? 0,
    },
  });
  return result;
}
