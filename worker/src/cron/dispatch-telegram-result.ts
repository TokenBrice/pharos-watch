import type { TelegramDispatchCronResult } from "@shared/types";
import { TELEGRAM_DISPATCH_INTERVAL_SEC, TELEGRAM_PENDING_DRAIN_BUDGET } from "./telegram-pending";
import { emptyPerAlertTypeDelivery } from "./dispatch-telegram-routing";
import type { TelegramAlertType } from "@shared/types/status";
import type { readPendingCapacitySnapshot } from "./telegram-pending";

export type PerAlertTypeTargets = Record<TelegramAlertType, { chats: number; chunks: number }>;

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
  pendingCapacityBefore: Awaited<ReturnType<typeof readPendingCapacitySnapshot>>;
  pendingCapacityAfter: Awaited<ReturnType<typeof readPendingCapacitySnapshot>>;
  perAlertTypeTargets: PerAlertTypeTargets;
  fanoutQueryMs: number;
  fanoutBuildMs: number;
  fanoutTotalMs: number;
  /** C128: chats whose multi-coin set collapsed to a single burst-summary chunk this run. */
  burstCollapsedChats?: number;
  /** C128: bursting chats fully suppressed this run because their coin set was already summarized. */
  burstDeltaSuppressed?: number;
  /** True when the reserve producer source is not currently alertable. */
  reserveSourceUnavailable: boolean;
}

export type DispatchResult = TelegramDispatchCronResult & DispatchCapacityMetadata;

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
    targets[sub.alertType].chats += 1;
    targets[sub.alertType].chunks += sub.chunks.length;
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
  } satisfies Awaited<ReturnType<typeof readPendingCapacitySnapshot>>;
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
    suppressedSafetyChangesAtSeed: 0,
    reserveSourceUnavailable: false,
  };
}
