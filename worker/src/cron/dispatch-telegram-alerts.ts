import { throwIfAborted } from "../lib/abort";
import type { AlertSafetySourceAssessment } from "../lib/alert-safety-source-cache";
import type { AlertReserveSourceAssessment } from "../lib/alert-reserve-source-cache";
import { getCache, setCache } from "../lib/db-cache";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportDigestProgress } from "./digest/progress";

import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { writeSnapshots } from "./telegram-alert-snapshots";
import { buildDispatchSnapshotState, loadDispatchSourceData } from "./dispatch-telegram-state";
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
import type { PlannedSubscriberAlert } from "./dispatch-telegram-routing";
import { pendingCapacityFields } from "./dispatch-telegram-alerts-fanout";
import {
  drainOverflowBacklogOnly,
  persistEventlessOverflowBacklog,
} from "./dispatch-telegram-overflow";
import { logTelegramEvent } from "../lib/telegram-log";
import { TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } from "../lib/telegram-constants";
import {
  buildTelegramDispatchEvents,
  countSuppressedSafetyChangesAtSeed,
} from "./dispatch-telegram-events";
import {
  buildTelegramAlertSourceEvent,
  completeTelegramAlertSourceEvent,
  expireTelegramAlertSourceEvent,
  loadOldestIncompleteTelegramAlertSourceEvent,
  persistTelegramAlertSourceEvent,
  type TelegramAlertSourceEvent,
} from "./telegram-alert-source-events";
import { getSymbol } from "./dispatch-telegram-predicates";
import {
  emptyResult,
  type DispatchResult,
} from "./dispatch-telegram-result";
import { executeAuthoritativeFanoutPath } from "./dispatch-telegram-authoritative-path";
import { expireTelegramTargetPlanSource } from "./telegram-alert-target-plans";
import { inspectAndImportLegacyOverflowBacklog } from "./telegram-legacy-overflow-import";

const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";
const TELEGRAM_ALERT_PROVIDER_FAMILIES = ["dews", "depeg", "safety", "launch", "reserve"] as const;

export interface TelegramDispatchSharedState {
  pendingCapacitySnapshot?: PendingCapacitySnapshot;
  safetySourceAssessment?: AlertSafetySourceAssessment;
}

function pendingTailState(snapshot: PendingCapacitySnapshot | null | undefined): Record<string, unknown> | null {
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

async function readPresetFailureCount(db: D1Database): Promise<number> {
  try {
    const cached = await getCache(db, PRESET_QUERY_FAILURE_CACHE_KEY);
    if (!cached) return 0;
    const parsed = Number(cached.value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

async function writePresetFailureCount(db: D1Database, value: number): Promise<void> {
  try {
    await setCache(db, PRESET_QUERY_FAILURE_CACHE_KEY, String(Math.max(0, Math.floor(value))));
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "failed to persist preset failure count",
      action: "write-preset-failure-count",
      module: "dispatch-telegram-alerts",
    });
  }
}

function assignSharedDispatchState(
  sharedState: TelegramDispatchSharedState | undefined,
  updates: Partial<TelegramDispatchSharedState>,
): void {
  if (!sharedState) return;
  Object.assign(sharedState, updates);
}

function safetySourceFields(
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

function reserveSourceFields(assessment: AlertReserveSourceAssessment) {
  return {
    reserveAlertSourceState: assessment.state,
    reserveAlertSourceAgeSeconds: assessment.ageSeconds,
    reserveAlertsSuppressed: assessment.state !== "ok",
    reserveAlertSourceGeneration: assessment.generation,
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

function shouldRecordTelegramDispatchFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  telegramDeliveryStarted: boolean,
): boolean {
  if (signal?.aborted || isAbortError(error)) return false;
  return telegramDeliveryStarted;
}

type DispatchSnapshotState = ReturnType<typeof buildDispatchSnapshotState>;
type DispatchEvents = Awaited<ReturnType<typeof buildTelegramDispatchEvents>>;
type PendingDispatchFields = Pick<
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

function pendingDispatchFields(
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

interface SeedPathContext {
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

interface EventlessFastPathContext {
  db: D1Database;
  botToken: string;
  currentSnapshots: DispatchSnapshotState["currentSnapshots"];
  reserveSourceUnavailable: boolean;
  reserveSourceAssessment: AlertReserveSourceAssessment;
  safetySourceAssessment: AlertSafetySourceAssessment;
  suppressedMethodologyChanges: number;
  suppressedSafetyChangesAtSeed: number;
  pendingCapacityBefore: PendingCapacitySnapshot;
  overflowBacklog: readonly PlannedSubscriberAlert[];
  nowSec: number;
  dispatchStartedAtMs: number;
  chatsWithActiveSnooze: number;
  signal?: AbortSignal;
  sharedState?: TelegramDispatchSharedState;
  reportProgress?: CronProgressReporter;
  markTelegramDeliveryStarted?: () => void;
}

interface FullFanoutPathContext {
  db: D1Database;
  botToken: string;
  snapshotState: DispatchSnapshotState;
  events: DispatchEvents;
  sourceEvent: TelegramAlertSourceEvent;
  suppressedSafetyChangesAtSeed: number;
  pendingCapacityBefore: PendingCapacitySnapshot;
  overflowBacklog: readonly PlannedSubscriberAlert[];
  nowSec: number;
  dispatchStartedAtMs: number;
  chatsWithActiveSnooze: number;
  signal?: AbortSignal;
  sharedState?: TelegramDispatchSharedState;
  reportProgress?: CronProgressReporter;
  markTelegramDeliveryStarted?: () => void;
}

interface CircuitOpenQueuePathContext {
  db: D1Database;
  botToken: string;
  nowSec: number;
  dispatchStartedAtMs: number;
  signal?: AbortSignal;
  sharedState?: TelegramDispatchSharedState;
  reportProgress?: CronProgressReporter;
}

async function executeSeedPath({
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
  await reportDigestProgress(reportProgress, {
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
  const result = emptyResult(true, chatsWithActiveSnooze);
  result.pendingCapacityBefore = pendingCapacityBefore;
  result.pendingCapacityAfter = pendingCapacityBefore;
  Object.assign(result, pendingCapacityFields(pendingCapacityBefore));
  Object.assign(
    result,
    safetySourceFields(
      safetySourceAssessment,
      safetySourceAssessment.state !== "ok" || safetySnapshotNeedsSeed,
    ),
  );
  result.suppressedSafetyChangesAtSeed = suppressedSafetyChangesAtSeed;
  result.reserveSourceUnavailable = reserveSourceUnavailable;
  Object.assign(result, reserveSourceFields(reserveSourceAssessment));
  assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityBefore });
  await reportDigestProgress(reportProgress, {
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

async function executeCircuitOpenQueuePath({
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

async function executeEventlessFastPath({
  db,
  botToken,
  currentSnapshots,
  reserveSourceUnavailable,
  reserveSourceAssessment,
  safetySourceAssessment,
  suppressedMethodologyChanges,
  suppressedSafetyChangesAtSeed,
  pendingCapacityBefore,
  overflowBacklog,
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
  const overflowDeliveryResult = await drainOverflowBacklogOnly({
    db,
    botToken,
    overflowBacklog,
    drainResult,
    nowSec,
    signal,
    markTelegramDeliveryStarted,
  });
  await persistEventlessOverflowBacklog(db, overflowDeliveryResult, overflowBacklog, nowSec);
  const pendingCapacityAfter = await readPendingCapacityAfterLifecycle(
    db,
    nowSec,
    pendingCapacityBefore,
    drainResult,
    expiredCount,
    {
      pendingEnqueued: overflowDeliveryResult?.pendingEnqueued ?? 0,
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
    cappedAtLimit: overflowDeliveryResult?.cappedAtLimit ?? false,
    ...pendingDispatchFields(drainResult, {
      expiredCount,
      pendingEnqueued: overflowDeliveryResult?.pendingEnqueued ?? 0,
    }),
    reserveSourceUnavailable,
    ...reserveSourceFields(reserveSourceAssessment),
    ...pendingCapacityFields(pendingCapacityAfter),
    pendingCapacityBefore,
    pendingCapacityAfter,
    freshOverflow: overflowDeliveryResult?.freshOverflow ?? 0,
    chatsWithActiveSnooze,
    ...safetySourceFields(safetySourceAssessment, false),
    perAlertType: overflowDeliveryResult?.perAlertType ?? base.perAlertType,
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

async function executeFullFanoutPath(
  context: FullFanoutPathContext,
): Promise<DispatchResult> {
  return executeAuthoritativeFanoutPath(context, {
    updatePresetFailureState: async (failed) => {
      if (!failed) {
        await writePresetFailureCount(context.db, 0);
        return;
      }
      await writePresetFailureCount(
        context.db,
        (await readPresetFailureCount(context.db)) + 1,
      );
    },
  });
}

async function executeSourceRecoveryQueueSidecar(args: {
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
export async function dispatchTelegramAlerts(
  db: D1Database,
  botToken: string,
  signal?: AbortSignal,
  sharedState?: TelegramDispatchSharedState,
  reportProgress?: CronProgressReporter,
): Promise<{ itemCount: number; metadata: string }> {
  await reportDigestProgress(reportProgress, {
    stage: "circuit-check",
    message: "Checking Telegram API circuit",
    providerFamily: "telegram-api",
    itemsDone: 0,
    itemsTotal: 1,
  });
  const dispatchStartedAtMs = Date.now();
  const dispatchNowSec = Math.floor(dispatchStartedAtMs / 1000);
  const legacyOverflowImport = await inspectAndImportLegacyOverflowBacklog(db, dispatchNowSec);
  const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);
  if (!allowed) {
    const nowSec = dispatchNowSec;
    const result = await executeCircuitOpenQueuePath({
      db,
      botToken,
      nowSec,
      dispatchStartedAtMs,
      signal,
      sharedState,
      reportProgress,
    });
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipped fresh Telegram dispatch because the API circuit is open",
      providerFamily: "telegram-api",
      itemsDone: result.pendingAttempted,
      itemsTotal: Math.max(result.pendingCapacityBefore.due, result.pendingAttempted, 1),
      metadata: {
        skipped: "circuit-open",
        deferredTail: pendingTailState(result.pendingCapacityAfter),
      },
    });
    return { itemCount: result.messagesSent, metadata: JSON.stringify(result) };
  }

  let telegramDeliveryStarted = false;
  const markTelegramDeliveryStarted = () => {
    telegramDeliveryStarted = true;
  };

  try {
    throwIfAborted(signal);

    await reportDigestProgress(reportProgress, {
      stage: "source-loading",
      message: "Loading Telegram alert source snapshots",
      providerFamily: "telegram-dispatch",
      itemsDone: 0,
      itemsTotal: 5,
      metadata: {
        providerFamilies: TELEGRAM_ALERT_PROVIDER_FAMILIES,
      },
    });
    const sourceData = await loadDispatchSourceData(db);
    const { chatsWithActiveSnooze } = sourceData;

    throwIfAborted(signal);

    const nowSec = dispatchNowSec;
    const snapshotState = buildDispatchSnapshotState(sourceData, nowSec);
    const {
      currentSnapshots,
      mustSeedSnapshots,
      safetySnapshotNeedsSeed,
      safetySourceAssessment,
    } = snapshotState;
    assignSharedDispatchState(sharedState, { safetySourceAssessment });

    const suppressedSafetyChangesAtSeed = countSuppressedSafetyChangesAtSeed(snapshotState, getSymbol);
    const pendingCapacityBefore = await readPendingCapacitySnapshot(db, nowSec);
    const overflowBacklog: readonly PlannedSubscriberAlert[] = [];
    assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityBefore });
    await reportDigestProgress(reportProgress, {
      stage: "source-loaded",
      message: "Loaded Telegram alert source snapshots",
      providerFamily: "telegram-dispatch",
      itemsDone: 5,
      itemsTotal: 5,
      metadata: {
        providerFamilies: TELEGRAM_ALERT_PROVIDER_FAMILIES,
        countTotals: {
          dewsRows: sourceData.dewsRows.length,
          activeDepegRows: sourceData.activeDepegRows.length,
          safetyRows: sourceData.safetyRows.length,
          reserveDriftIds: snapshotState.currentReserveDriftIds.length,
          chatsWithActiveSnooze,
          overflowBacklogChats: overflowBacklog.length,
          legacyOverflowImportState: legacyOverflowImport.state,
          legacyOverflowImportCursor: legacyOverflowImport.importCursor,
        },
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveAlertSourceState: snapshotState.reserveSourceAssessment.state,
        reserveAlertSourceAgeSeconds: snapshotState.reserveSourceAssessment.ageSeconds,
        reserveAlertSourceGeneration: snapshotState.reserveSourceAssessment.generation,
        safetyAlertSourceState: safetySourceAssessment.state,
        safetyAlertSourceAgeSeconds: safetySourceAssessment.ageSeconds,
        deferredTail: pendingTailState(pendingCapacityBefore),
      },
    });

    let sourceEvent = await loadOldestIncompleteTelegramAlertSourceEvent(db);
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
        return { itemCount: sidecar.messagesSent, metadata: JSON.stringify(result) };
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
      await reportDigestProgress(reportProgress, {
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
      return { itemCount: sidecar.messagesSent, metadata: JSON.stringify(result) };
    }

    if (mustSeedSnapshots && !sourceEvent) {
      const result = await executeSeedPath({
        db,
        currentSnapshots,
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveSourceAssessment: snapshotState.reserveSourceAssessment,
        safetySnapshotNeedsSeed,
        safetySourceAssessment,
        suppressedSafetyChangesAtSeed,
        pendingCapacityBefore,
        chatsWithActiveSnooze,
        sharedState,
        reportProgress,
      });
      return { itemCount: 0, metadata: JSON.stringify(result) };
    }

    await reportDigestProgress(reportProgress, {
      stage: "event-detection",
      message: "Detecting Telegram alert events",
      providerFamily: "telegram-dispatch",
      itemsDone: 0,
      itemsTotal: 5,
      metadata: {
        providerFamilies: TELEGRAM_ALERT_PROVIDER_FAMILIES,
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveAlertSourceState: snapshotState.reserveSourceAssessment.state,
      },
    });
    const dispatchEvents = sourceEvent?.events ?? await buildTelegramDispatchEvents(
      db,
      sourceData,
      snapshotState,
      getSymbol,
      signal,
    );
    const {
      dewsChanges,
      depegTriggered,
      depegResolved,
      depegWorsening,
      safetyChanges,
      launchPromoted,
      reservePromoted,
      suppressedMethodologyChanges,
      dewsIds,
      depegIds,
      safetyIds,
      launchIds,
      reserveIds,
    } = dispatchEvents;
    const eventCount =
      dewsChanges.length +
      depegTriggered.length +
      depegResolved.length +
      depegWorsening.length +
      safetyChanges.length +
      launchPromoted.length +
      reservePromoted.length;

    const requiresFullFanoutPath =
      eventCount > 0 ||
      safetySourceAssessment.state !== "ok" ||
      safetySnapshotNeedsSeed;
    if (!sourceEvent && requiresFullFanoutPath) {
      sourceEvent = await persistTelegramAlertSourceEvent(
        db,
        await buildTelegramAlertSourceEvent({
          events: dispatchEvents,
          baseline: currentSnapshots,
          detectedAt: nowSec,
        }),
        signal,
      );
    }
    await reportDigestProgress(reportProgress, {
      stage: "event-detection-complete",
      message: "Completed Telegram alert event detection",
      providerFamily: "telegram-dispatch",
      itemsDone: eventCount,
      itemsTotal: Math.max(eventCount, 1),
      metadata: {
        providerFamilies: TELEGRAM_ALERT_PROVIDER_FAMILIES,
        countTotals: {
          dews: dewsChanges.length,
          depegTriggered: depegTriggered.length,
          depegResolved: depegResolved.length,
          depegWorsening: depegWorsening.length,
          safety: safetyChanges.length,
          launch: launchPromoted.length,
          reserve: reservePromoted.length,
          suppressedMethodologyChanges,
        },
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveAlertSourceState: snapshotState.reserveSourceAssessment.state,
        sourceEventId: sourceEvent?.sourceEventId ?? null,
        resumedSourceEvent,
      },
    });

    const hasEvents = eventCount > 0;
    const canUseEventlessFastPath =
      !hasEvents &&
      safetySourceAssessment.state === "ok" &&
      !safetySnapshotNeedsSeed;

    if (canUseEventlessFastPath) {
      const result = await executeEventlessFastPath({
        db,
        botToken,
        currentSnapshots,
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveSourceAssessment: snapshotState.reserveSourceAssessment,
        safetySourceAssessment,
        suppressedMethodologyChanges,
        suppressedSafetyChangesAtSeed,
        pendingCapacityBefore,
        overflowBacklog,
        nowSec,
        dispatchStartedAtMs,
        chatsWithActiveSnooze,
        signal,
        sharedState,
        reportProgress,
        markTelegramDeliveryStarted,
      });
      return { itemCount: result.messagesSent, metadata: JSON.stringify(result) };
    }

    if (!sourceEvent) {
      throw new Error("Telegram alert events were not persisted before fanout");
    }

    const result = await executeFullFanoutPath({
      db,
      botToken,
      snapshotState,
      events: {
        dewsChanges,
        depegTriggered,
        depegResolved,
        depegWorsening,
        safetyChanges,
        launchPromoted,
        reservePromoted,
        suppressedMethodologyChanges,
        dewsIds,
        depegIds,
        safetyIds,
        launchIds,
        reserveIds,
      },
      sourceEvent,
      pendingCapacityBefore,
      overflowBacklog,
      suppressedSafetyChangesAtSeed,
      nowSec,
      dispatchStartedAtMs,
      chatsWithActiveSnooze,
      signal,
      sharedState,
      reportProgress,
      markTelegramDeliveryStarted,
    });

    return { itemCount: result.messagesSent, metadata: JSON.stringify(result) };
  } catch (error) {
    if (shouldRecordTelegramDispatchFailure(error, signal, telegramDeliveryStarted)) {
      await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
    }
    throw error;
  }
}
