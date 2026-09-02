import type { CronProgressReporter } from "../lib/cron-logger";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "../lib/stablecoins-cache";
import {
  createTelegramAuthoritativePlanningCallbacks,
  type TelegramAuthoritativePlanningCallbacks,
} from "./dispatch-telegram-authoritative-planning";
import {
  activeTelegramEventFamilies,
  summarizeTelegramDispatchEvents,
  toTelegramFanoutPlanEvents,
  type buildTelegramDispatchEvents,
} from "./dispatch-telegram-events";
import {
  buildDispatchResult,
  type DispatchResult,
} from "./dispatch-telegram-result";
import type { buildDispatchSnapshotState } from "./dispatch-telegram-state";
import { reportCronProgress } from "../lib/cron-progress";
import {
  drainPendingQueue,
  emptyDrainResult,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  type PendingCapacitySnapshot,
} from "./telegram-pending";
import { runPendingQueueLifecycle } from "./dispatch-telegram-pending-lifecycle";
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
  let pendingDrainSendMs = 0;
  const timedPendingDrain = async () => {
    const startedAtMs = Date.now();
    try {
      return await drainPendingQueue(db, context.botToken, TELEGRAM_PENDING_DRAIN_BUDGET, context.signal, {
        softDeadlineAtMs: context.dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
        markTelegramDeliveryStarted: context.markTelegramDeliveryStarted,
      });
    } finally {
      pendingDrainSendMs += Math.max(0, Date.now() - startedAtMs);
    }
  };
  const prePlanDrainResult = context.pendingCapacityBefore.due > 0
    ? await timedPendingDrain()
    : null;
  const fanoutStartedAtMs = Date.now();
  let cacheResult: Promise<StablecoinsCacheLoadResult> | null = null;
  const sourceResolutionStartedAtMs = Date.now();
  const sourceResolution = await resolveTelegramAlertSourcePresetPages(db, sourceEvent, nowSec, {
    getStablecoinsCacheResult: () => {
      cacheResult ??= loadStablecoinsCache(db, { mode: "strict" });
      return cacheResult;
    },
    includeSubscriberMaps: false,
  });
  const sourcePresetResolutionMs = Math.max(0, Date.now() - sourceResolutionStartedAtMs);
  await hooks.updatePresetFailureState(
    sourceResolution.queryFailures > 0 || sourceResolution.resolutionFailures > 0,
  );

  let planner: Awaited<ReturnType<typeof runTelegramTargetPlanCoordinator>> | null = null;
  let planningCallbacks: TelegramAuthoritativePlanningCallbacks | null = null;
  if (sourceResolution.allComplete) {
    const handoffAllowance = await readTelegramFreshHandoffAllowance(
      db,
      nowSec,
      Number.MAX_SAFE_INTEGER,
    );
    await markTelegramAlertSourceEventPlanned(db, sourceEvent.sourceEventId, nowSec);
    planningCallbacks = createTelegramAuthoritativePlanningCallbacks({
      db,
      sourceEventId: sourceEvent.sourceEventId,
      nowSec,
      events: toTelegramFanoutPlanEvents(events),
      stablecoinIds: {
        dewsIds: events.dewsIds,
        depegIds: events.depegIds,
        safetyIds: events.safetyIds,
        launchIds: events.launchIds,
        reserveIds: events.reserveIds,
      },
    });
    planner = await runTelegramTargetPlanCoordinator({
      db,
      sourceEventId: sourceEvent.sourceEventId,
      nowSec,
      signal: context.signal,
      maxSteps: TELEGRAM_TARGET_PLAN_MAX_STEPS_PER_RUN,
      deliveryHandoffLimit: handoffAllowance.maxTargets,
      callbacks: planningCallbacks,
      onStep: async (step) => {
        if (step.step !== 1 && step.step % 8 !== 0) return;
        await reportCronProgress(context.reportProgress, {
          stage: "target-plan-progress",
          message: `Advancing Telegram target plan (${step.state})`,
          providerFamily: "telegram-dispatch",
          itemsDone: step.step,
          itemsTotal: TELEGRAM_TARGET_PLAN_MAX_STEPS_PER_RUN,
          metadata: {
            sourceEventId: step.sourceEventId,
            plannerGeneration: step.generation,
            plannerState: step.state,
          },
        });
      },
    });
  }
  const progress = await loadTelegramTargetPlanProgress(db, sourceEvent.sourceEventId);
  const fanoutMs = Math.max(0, Date.now() - fanoutStartedAtMs);
  await reportCronProgress(context.reportProgress, {
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

  // Like the recovery sidecar (and unlike the circuit-open/eventless paths)
  // this path expires TTL-dead rows on every run.
  const lifecycle = await runPendingQueueLifecycle({
    db,
    nowSec,
    pendingCapacityBefore: context.pendingCapacityBefore,
    drainResult: prePlanDrainResult ?? ((planner?.enqueued ?? 0) > 0
      ? await timedPendingDrain()
      : emptyDrainResult()),
    cleanupExpired: "always",
    capacityRefreshBasis: "drain-attempted",
    forceCapacityRefresh: (planner?.enqueued ?? 0) > 0,
    pendingEnqueued: planner?.enqueued ?? 0,
    outcomePolicy: "attempted-only",
    sharedState: context.sharedState,
  });
  const { drainResult, expiredCount, pendingCapacityAfter } = lifecycle;

  if (planner?.state === "delivery_open" && planner.remainingTargets === 0) {
    await commitTelegramAlertSourceBaseline(db, sourceEvent, nowSec, context.signal);
    await completeTelegramAlertSourceEvent(db, sourceEvent.sourceEventId, nowSec);
  } else if (planner?.state === "expired" && planner.expiryComplete) {
    await expireTelegramAlertSourceEvent(db, sourceEvent, nowSec, context.signal);
  }

  const planningTelemetry = planningCallbacks?.getTelemetry();
  const eventSummary = summarizeTelegramDispatchEvents(events);
  const result = buildDispatchResult({
    snapshotSeeded: false,
    chatsWithActiveSnooze: context.chatsWithActiveSnooze,
    eventOverrides: eventSummary.eventsDetected,
    pendingLifecycle: {
      drainResult,
      expiredCount,
      pendingEnqueued: planner?.enqueued ?? 0,
    },
    capacity: { before: context.pendingCapacityBefore, after: pendingCapacityAfter },
    reserve: {
      assessment: snapshotState.reserveSourceAssessment,
      unavailable: snapshotState.reserveSourceUnavailable,
    },
    safety: {
      assessment: snapshotState.safetySourceAssessment,
      suppressed:
        snapshotState.safetySourceAssessment.state !== "ok" || snapshotState.safetySnapshotNeedsSeed,
    },
    overrides: {
      subscribersNotified: drainResult.acceptedChats,
      cappedAtLimit: hasDeferredTelegramAuthoritativeWork(sourceResolution.allComplete, planner),
      freshCandidateChats: Number(progress.planningOutcomes.target_planned ?? 0),
      freshCandidateCount: progress.targets,
      freshOverflow: planner?.remainingTargets ?? 0,
      presetQueryFailures: sourceResolution.queryFailures,
      presetResolutionFailures: sourceResolution.resolutionFailures,
      presetFailure: !sourceResolution.allComplete,
      fanoutQueryMs: fanoutMs,
      fanoutBuildMs: 0,
      fanoutTotalMs: fanoutMs,
      authoritativePlanning: {
        sourceEventId: sourceEvent.sourceEventId,
        sourceEventFamilies: activeTelegramEventFamilies(events),
        sourcePresetResolutionMs,
        sourcePresetPagesCompleted: sourceResolution.pagesCompletedThisRun,
        candidateHorizonQueryMs: planningTelemetry?.candidateHorizonQueryMs ?? 0,
        captureEligibilityMs: planningTelemetry?.captureEligibilityMs ?? 0,
        fanoutInputLoadMs: planningTelemetry?.fanoutInputLoadMs ?? 0,
        directSubscriberLoadMs: planningTelemetry?.directSubscriberLoadMs ?? 0,
        presetSubscriberLoadMs: planningTelemetry?.presetSubscriberLoadMs ?? 0,
        globalSubscriberLoadMs: planningTelemetry?.globalSubscriberLoadMs ?? 0,
        snoozeExplicitOffLoadMs: planningTelemetry?.snoozeExplicitOffLoadMs ?? 0,
        preferenceGenerationValidationMs: planningTelemetry?.preferenceGenerationValidationMs ?? 0,
        routingEvaluationMs: planningTelemetry?.routingEvaluationMs ?? 0,
        targetMaterializationD1Ms: planner?.targetMaterializationMs ?? 0,
        enqueueHandoffMs: planner?.targetHandoffMs ?? 0,
        duplicatePriorDeliverySuppressionMs: planner?.duplicateSuppressionMs ?? 0,
        pendingDrainSendMs,
        capturedSubscriberCount: progress.capturedSubscribers,
        capturePageCount: planner?.capturePages ?? 0,
        planningPageCount: planner?.planningPages ?? 0,
        fanoutInputLoadCallCount: planningTelemetry?.fanoutInputLoadCalls ?? 0,
        fanoutInputCacheHitCount: planningTelemetry?.fanoutInputCacheHits ?? 0,
        plannedTargetCount: progress.targets,
        duplicateSuppressedTargetCount: planner?.duplicateSuppressed ?? 0,
        handoffEnqueuedCount: planner?.enqueued ?? 0,
        handoffPageCount: planner?.handoffPages ?? 0,
        coordinatorStepCount: planner?.steps ?? 0,
      },
      suppressedSafetyChangesAtSeed: context.suppressedSafetyChangesAtSeed,
    },
  });
  await lifecycle.recordDrainOutcome();
  await reportCronProgress(context.reportProgress, {
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
