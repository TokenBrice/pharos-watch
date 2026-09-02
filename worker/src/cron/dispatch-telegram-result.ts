import type { TelegramDispatchCronResult } from "@shared/types";
import { TELEGRAM_DISPATCH_INTERVAL_SEC, TELEGRAM_PENDING_DRAIN_BUDGET } from "./telegram-pending";
import { emptyPerAlertTypeDelivery } from "./dispatch-telegram-routing";
import type { TelegramAlertType } from "@shared/types/status";
import { readTelegramPendingCapacitySnapshot } from "../lib/telegram-pending-capacity";
import type {
  PendingCapacitySnapshot,
  PendingDrainResult,
} from "./telegram-pending";
import type { AlertSafetySourceAssessment } from "../lib/alert-safety-source-cache";
import type { AlertReserveSourceAssessment } from "../lib/alert-reserve-source-cache";
import { pendingCapacityFields } from "./dispatch-telegram-alerts-fanout";

export type PerAlertTypeTargets = Record<Exclude<TelegramAlertType, "freeze">, { chats: number; chunks: number }> &
  Partial<Record<"freeze", { chats: number; chunks: number }>>;

export interface DispatchCapacityMetadata {
  freshCandidateChats: number;
  freshCandidateCount: number;
  freshOverflow: number;
  pendingSent: number;
  pendingTotal: number;
  pendingDue: number;
  pendingDeferredCount: number;
  pendingExpiredCount: number;
  pendingNearTtlCount: number;
  oldestPendingAgeSec: number | null;
  oldestDuePendingAgeSec: number | null;
  estimatedDrainTimeSec: number;
  pendingDrainBudgetPerRun: number;
  pendingCapacityBefore: Awaited<ReturnType<typeof readTelegramPendingCapacitySnapshot>>;
  pendingCapacityAfter: Awaited<ReturnType<typeof readTelegramPendingCapacitySnapshot>>;
  perAlertTypeTargets: PerAlertTypeTargets;
  fanoutQueryMs: number;
  fanoutBuildMs: number;
  fanoutTotalMs: number;
  authoritativePlanning: {
    sourceEventId: string | null;
    sourceEventFamilies: string[];
    sourcePresetResolutionMs: number;
    sourcePresetPagesCompleted: number;
    candidateHorizonQueryMs: number;
    captureEligibilityMs: number;
    fanoutInputLoadMs: number;
    directSubscriberLoadMs: number;
    presetSubscriberLoadMs: number;
    globalSubscriberLoadMs: number;
    snoozeExplicitOffLoadMs: number;
    preferenceGenerationValidationMs: number;
    routingEvaluationMs: number;
    targetMaterializationD1Ms: number;
    enqueueHandoffMs: number;
    duplicatePriorDeliverySuppressionMs: number;
    pendingDrainSendMs: number;
    capturedSubscriberCount: number;
    capturePageCount: number;
    planningPageCount: number;
    fanoutInputLoadCallCount: number;
    fanoutInputCacheHitCount: number;
    plannedTargetCount: number;
    duplicateSuppressedTargetCount: number;
    handoffEnqueuedCount: number;
    handoffPageCount: number;
    coordinatorStepCount: number;
  };
  /** C128: chats whose multi-coin set collapsed to a single burst-summary chunk this run. */
  burstCollapsedChats?: number;
  /** C128: bursting chats fully suppressed this run because their coin set was already summarized. */
  burstDeltaSuppressed?: number;
  /** True when the reserve producer source is not currently alertable. */
  reserveSourceUnavailable: boolean;
}

export type DispatchResult = TelegramDispatchCronResult & DispatchCapacityMetadata;

export function pendingTailState(snapshot: PendingCapacitySnapshot | null | undefined): Record<string, unknown> | null {
  if (!snapshot) return null;
  return {
    total: snapshot.total,
    active: snapshot.active,
    due: snapshot.due,
    deferred: snapshot.deferred,
    expired: snapshot.expired,
    nearTtl: snapshot.nearTtl,
    oldestPendingAgeSec: snapshot.oldestPendingAgeSec,
    estimatedDrainTimeSec: snapshot.estimatedDrainTimeSec,
  };
}

export function safetySourceFields(
  assessment: AlertSafetySourceAssessment,
  suppressed: boolean,
) {
  return {
    safetyAlertSourceState: assessment.state,
    safetyAlertSourceAgeSeconds: assessment.ageSeconds,
    safetyAlertsSuppressed: suppressed,
    safetyAlertSourceGeneration: assessment.generation,
  };
}

export function reserveSourceFields(assessment: AlertReserveSourceAssessment) {
  return {
    reserveAlertSourceState: assessment.state,
    reserveAlertSourceAgeSeconds: assessment.ageSeconds,
    reserveAlertsSuppressed: assessment.state !== "ok",
    reserveAlertSourceGeneration: assessment.generation,
  };
}

export type PendingDispatchFields = Pick<
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
>;

export function pendingDispatchFields(
  drainResult: PendingDrainResult,
  {
    expiredCount,
    pendingEnqueued = 0,
  }: {
    expiredCount: number;
    pendingEnqueued?: number;
  },
): PendingDispatchFields {
  return {
    pendingAttempted: drainResult.attempted,
    pendingDrained: drainResult.sent,
    pendingSent: drainResult.sent,
    pendingRetryQueued: drainResult.retryQueued,
    pendingDropped: drainResult.dropped,
    pendingDroppedTtlExpired: expiredCount,
    pendingDroppedPermanentFailure: drainResult.droppedPermanentFailure,
    pendingDroppedMaxAttemptsFallback: drainResult.droppedMaxAttemptsFallback,
    pendingDeferred: drainResult.deferred,
    pendingRateLimited: drainResult.rateLimited,
    pendingRetryAfterSec: drainResult.retryAfterSec,
    pendingEnqueued,
    pendingExpired: expiredCount,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function shouldRecordTelegramDispatchFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  telegramDeliveryStarted: boolean,
): boolean {
  if (signal?.aborted || isAbortError(error)) return false;
  return telegramDeliveryStarted;
}

function emptyPerAlertTypeTargets(): PerAlertTypeTargets {
  return {
    dews: { chats: 0, chunks: 0 },
    depeg: { chats: 0, chunks: 0 },
    safety: { chats: 0, chunks: 0 },
    launch: { chats: 0, chunks: 0 },
    reserve: { chats: 0, chunks: 0 },
  };
}

export function buildPerAlertTypeTargets(
  subscriberQueue: Array<{ alertType: TelegramAlertType; chunks: string[] }>,
): PerAlertTypeTargets {
  const targets = emptyPerAlertTypeTargets();
  for (const sub of subscriberQueue) {
    (targets[sub.alertType] ??= { chats: 0, chunks: 0 }).chats += 1;
    targets[sub.alertType]!.chunks += sub.chunks.length;
  }
  return targets;
}

function emptyPendingCapacity() {
  return {
    total: 0,
    active: 0,
    due: 0,
    deferred: 0,
    expired: 0,
    nearTtl: 0,
    sending: 0,
    pendingSending: 0,
    freshSending: 0,
    pendingExecutionUnknown: 0,
    freshExecutionUnknown: 0,
    executionUnknown: 0,
    sentCleanup: 0,
    oldestExecutionUnknownAgeSec: null,
    executionUnknownSampleLimit: 5_001,
    executionUnknownLowerBound: false,
    oldestPendingAgeSec: null,
    oldestDuePendingAgeSec: null,
    estimatedDrainTimeSec: 0,
    drainBudgetPerRun: TELEGRAM_PENDING_DRAIN_BUDGET,
    dispatchIntervalSec: TELEGRAM_DISPATCH_INTERVAL_SEC,
  } satisfies Awaited<ReturnType<typeof readTelegramPendingCapacitySnapshot>>;
}

export function emptyResult(snapshotSeeded: boolean, chatsWithActiveSnooze = 0): DispatchResult {
  return {
    eventsDetected: {
      dews: 0,
      depeg: 0,
      depegTriggered: 0,
      depegResolved: 0,
      depegWorsening: 0,
      safety: 0,
      launch: 0,
      reserve: 0,
      suppressedMethodologyChanges: 0,
    },
    subscribersNotified: 0,
    messagesSent: 0,
    blockedUsersCleanedUp: 0,
    blockedUsersCleanupFailed: 0,
    cappedAtLimit: false,
    snapshotSeeded,
    pendingAttempted: 0,
    pendingDrained: 0,
    pendingRetryQueued: 0,
    pendingDropped: 0,
    pendingDroppedTtlExpired: 0,
    pendingDroppedPermanentFailure: 0,
    pendingDroppedMaxAttemptsFallback: 0,
    pendingDeferred: 0,
    pendingRateLimited: false,
    pendingRetryAfterSec: null,
    pendingEnqueued: 0,
    pendingExpired: 0,
    pendingSent: 0,
    pendingTotal: 0,
    pendingDue: 0,
    pendingDeferredCount: 0,
    pendingExpiredCount: 0,
    pendingNearTtlCount: 0,
    oldestPendingAgeSec: null,
    oldestDuePendingAgeSec: null,
    estimatedDrainTimeSec: 0,
    pendingDrainBudgetPerRun: TELEGRAM_PENDING_DRAIN_BUDGET,
    pendingCapacityBefore: emptyPendingCapacity(),
    pendingCapacityAfter: emptyPendingCapacity(),
    freshAttempted: 0,
    freshSent: 0,
    freshRetryQueued: 0,
    freshPermanentFailures: 0,
    freshDeferredPerChat: 0,
    freshCandidateChats: 0,
    freshCandidateCount: 0,
    freshOverflow: 0,
    chatsWithActiveSnooze,
    safetyAlertSourceState: "missing",
    safetyAlertSourceAgeSeconds: null,
    safetyAlertsSuppressed: true,
    safetyAlertSourceGeneration: null,
    reserveAlertSourceState: "missing",
    reserveAlertSourceAgeSeconds: null,
    reserveAlertsSuppressed: true,
    reserveAlertSourceGeneration: null,
    presetQueryFailures: 0,
    presetResolutionFailures: 0,
    presetFailure: false,
    perAlertType: emptyPerAlertTypeDelivery(),
    perAlertTypeTargets: emptyPerAlertTypeTargets(),
    fanoutQueryMs: 0,
    fanoutBuildMs: 0,
    fanoutTotalMs: 0,
    authoritativePlanning: {
      sourceEventId: null,
      sourceEventFamilies: [],
      sourcePresetResolutionMs: 0,
      sourcePresetPagesCompleted: 0,
      candidateHorizonQueryMs: 0,
      captureEligibilityMs: 0,
      fanoutInputLoadMs: 0,
      directSubscriberLoadMs: 0,
      presetSubscriberLoadMs: 0,
      globalSubscriberLoadMs: 0,
      snoozeExplicitOffLoadMs: 0,
      preferenceGenerationValidationMs: 0,
      routingEvaluationMs: 0,
      targetMaterializationD1Ms: 0,
      enqueueHandoffMs: 0,
      duplicatePriorDeliverySuppressionMs: 0,
      pendingDrainSendMs: 0,
      capturedSubscriberCount: 0,
      capturePageCount: 0,
      planningPageCount: 0,
      fanoutInputLoadCallCount: 0,
      fanoutInputCacheHitCount: 0,
      plannedTargetCount: 0,
      duplicateSuppressedTargetCount: 0,
      handoffEnqueuedCount: 0,
      handoffPageCount: 0,
      coordinatorStepCount: 0,
    },
    suppressedSafetyChangesAtSeed: 0,
    reserveSourceUnavailable: false,
  };
}

export function buildDispatchResult(args: {
  snapshotSeeded: boolean;
  chatsWithActiveSnooze?: number;
  eventOverrides?: Partial<DispatchResult["eventsDetected"]>;
  pendingLifecycle?: {
    drainResult: PendingDrainResult;
    expiredCount: number;
    pendingEnqueued?: number;
  };
  capacity?: {
    before: PendingCapacitySnapshot;
    after: PendingCapacitySnapshot;
  };
  reserve?: {
    assessment: AlertReserveSourceAssessment;
    unavailable: boolean;
  };
  safety?: {
    assessment: AlertSafetySourceAssessment;
    suppressed: boolean;
  };
  overrides?: Partial<DispatchResult>;
}): DispatchResult {
  const result = emptyResult(args.snapshotSeeded, args.chatsWithActiveSnooze);
  if (args.eventOverrides) {
    result.eventsDetected = { ...result.eventsDetected, ...args.eventOverrides };
  }
  if (args.pendingLifecycle) {
    const { drainResult, expiredCount, pendingEnqueued } = args.pendingLifecycle;
    Object.assign(result, {
      messagesSent: drainResult.sent,
      blockedUsersCleanedUp: drainResult.blockedCleanedUp,
      blockedUsersCleanupFailed: drainResult.blockedCleanupFailed,
    });
    Object.assign(result, pendingDispatchFields(drainResult, { expiredCount, pendingEnqueued }));
  }
  if (args.capacity) {
    Object.assign(result, pendingCapacityFields(args.capacity.after));
    result.pendingCapacityBefore = args.capacity.before;
    result.pendingCapacityAfter = args.capacity.after;
  }
  if (args.reserve) {
    result.reserveSourceUnavailable = args.reserve.unavailable;
    Object.assign(result, reserveSourceFields(args.reserve.assessment));
  }
  if (args.safety) {
    Object.assign(result, safetySourceFields(args.safety.assessment, args.safety.suppressed));
  }
  Object.assign(result, args.overrides);
  return result;
}
