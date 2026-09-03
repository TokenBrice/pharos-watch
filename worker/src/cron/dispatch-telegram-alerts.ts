import { throwIfAborted } from "../lib/abort";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress } from "../lib/cron-progress";

import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import {
  buildDispatchSnapshotState,
  loadDispatchSourceData,
  readPresetFailureCount,
  writePresetFailureCount,
  assignSharedDispatchState,
  type DispatchSnapshotState,
} from "./dispatch-telegram-state";
import { readTelegramPendingCapacitySnapshot } from "../lib/telegram-pending-capacity";
import type { PendingCapacitySnapshot } from "./telegram-pending";
import {
  buildTelegramDispatchEvents,
  countSuppressedSafetyChangesAtSeed,
  summarizeTelegramDispatchEvents,
} from "./dispatch-telegram-events";
import {
  buildTelegramAlertSourceEvent,
  persistTelegramAlertSourceEvent,
  type TelegramAlertSourceEvent,
} from "./telegram-alert-source-events";
import { getSymbol } from "./dispatch-telegram-predicates";
import {
  pendingTailState,
  shouldRecordTelegramDispatchFailure,
  type DispatchResult,
} from "./dispatch-telegram-result";
import {
  executeCircuitOpenQueuePath,
  executeEventlessFastPath,
} from "./dispatch-telegram-queue-paths";
import {
  executeSeedPath,
  recoverIncompleteTelegramSourceEvent,
} from "./dispatch-telegram-source-lifecycle";
import { executeAuthoritativeFanoutPath } from "./dispatch-telegram-authoritative-path";
import { dispatchFreezeAlertOutbox } from "./telegram-freeze-outbox";

export type { TelegramDispatchSharedState } from "./dispatch-telegram-state";
import type { TelegramDispatchSharedState } from "./dispatch-telegram-state";

const TELEGRAM_ALERT_PROVIDER_FAMILIES = ["dews", "depeg", "safety", "launch", "reserve", "freeze"] as const;
const TELEGRAM_PLANNING_TABLES = [
  "telegram_alert_source_events",
  "telegram_alert_source_resolution",
  "telegram_alert_planning_subscribers",
  "telegram_alert_target_plans",
  "telegram_alert_target_plan_pages",
  "telegram_alert_target_plan_items",
  "telegram_alert_jobs",
  "telegram_alert_job_targets",
  "telegram_alert_job_target_items",
  "telegram_subscribers",
  "telegram_subscriptions",
  "telegram_preset_subscriptions",
] as const;

interface TelegramPlanningCounters {
  planningStatements: number;
}

function isTelegramPlanningStatement(sql: string): boolean {
  const normalizedSql = sql.toLowerCase();
  return TELEGRAM_PLANNING_TABLES.some((table) => normalizedSql.includes(table));
}

function createTelegramPlanningDatabase(
  db: D1Database,
  counters: TelegramPlanningCounters,
): D1Database {
  const countedDb = {
    ...db,
    prepare(sql: string) {
      if (isTelegramPlanningStatement(sql)) counters.planningStatements += 1;
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  };
  return countedDb as D1Database;
}

function parseTelegramDispatchMetadata(metadata: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function finiteMetadataNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addTelegramDispatchMetadataCounters(
  result: { itemCount: number; metadata: string },
  counters: TelegramPlanningCounters,
): { itemCount: number; metadata: string } {
  const metadata = parseTelegramDispatchMetadata(result.metadata);
  const pendingRowsEnqueued = Math.max(0, finiteMetadataNumber(metadata.pendingEnqueued) ?? 0);
  const sourceEventsProcessed = [
    metadata.sourceEventId,
    metadata.expiredSourceEventId,
    (metadata.authoritativePlanning as Record<string, unknown> | null)?.sourceEventId,
  ].some((value) => typeof value === "string" && value.length > 0)
    ? 1
    : 0;
  const pendingWork = [
    metadata.pendingAttempted,
    metadata.pendingExpired,
    metadata.pendingEnqueued,
    metadata.pendingDrained,
    metadata.pendingDropped,
    metadata.messagesSent,
    metadata.freezeObserved,
    metadata.freezeQueued,
    metadata.blockedUsersCleanedUp,
  ].some((value) => (finiteMetadataNumber(value) ?? 0) > 0);
  const noWorkRun = (metadata.eventlessFastPath === true || metadata.skipped === "circuit-open") && !pendingWork;
  const planningMs = Math.max(0, finiteMetadataNumber(metadata.fanoutTotalMs) ?? 0);

  return {
    ...result,
    metadata: JSON.stringify({
      ...metadata,
      planningStatements: Math.max(0, Math.floor(counters.planningStatements)),
      planningMs,
      sourceEventsProcessed,
      pendingRowsEnqueued,
      noWorkRun,
    }),
  };
}

type DispatchEvents = Awaited<ReturnType<typeof buildTelegramDispatchEvents>>;

interface FullFanoutPathContext {
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
  sharedState?: TelegramDispatchSharedState;
  reportProgress?: CronProgressReporter;
  markTelegramDeliveryStarted?: () => void;
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

async function dispatchTelegramAlertsImpl(
  db: D1Database,
  botToken: string,
  signal?: AbortSignal,
  sharedState?: TelegramDispatchSharedState,
  reportProgress?: CronProgressReporter,
): Promise<{ itemCount: number; metadata: string }> {
  await reportCronProgress(reportProgress, {
    stage: "circuit-check",
    message: "Checking Telegram API circuit",
    providerFamily: "telegram-api",
    itemsDone: 0,
    itemsTotal: 1,
  });
  const dispatchStartedAtMs = Date.now();
  const dispatchNowSec = Math.floor(dispatchStartedAtMs / 1000);
  const planningCounters: TelegramPlanningCounters = { planningStatements: 0 };
  const planningDb = createTelegramPlanningDatabase(db, planningCounters);
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
    await reportCronProgress(reportProgress, {
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
    return addTelegramDispatchMetadataCounters(
      { itemCount: result.messagesSent, metadata: JSON.stringify(result) },
      planningCounters,
    );
  }

  let telegramDeliveryStarted = false;
  const markTelegramDeliveryStarted = () => {
    telegramDeliveryStarted = true;
  };

  try {
    throwIfAborted(signal);

    await reportCronProgress(reportProgress, {
      stage: "source-loading",
      message: "Loading Telegram alert source snapshots",
      providerFamily: "telegram-dispatch",
      itemsDone: 0,
      itemsTotal: TELEGRAM_ALERT_PROVIDER_FAMILIES.length,
      metadata: {
        providerFamilies: TELEGRAM_ALERT_PROVIDER_FAMILIES,
      },
    });
    const sourceData = await loadDispatchSourceData(db);
    const { chatsWithActiveSnooze } = sourceData;

    // Freeze events use a dedicated durable outbox because the historical
    // generic target-plan table is intentionally constrained to five families.
    const freezeOutbox = await dispatchFreezeAlertOutbox(db, dispatchNowSec);

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
    const pendingCapacityBefore = await readTelegramPendingCapacitySnapshot(db, nowSec);
    assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityBefore });
    await reportCronProgress(reportProgress, {
      stage: "source-loaded",
      message: "Loaded Telegram alert source snapshots",
      providerFamily: "telegram-dispatch",
      itemsDone: TELEGRAM_ALERT_PROVIDER_FAMILIES.length,
      itemsTotal: TELEGRAM_ALERT_PROVIDER_FAMILIES.length,
      metadata: {
        providerFamilies: TELEGRAM_ALERT_PROVIDER_FAMILIES,
        countTotals: {
          dewsRows: sourceData.dewsRows.length,
          activeDepegRows: sourceData.activeDepegRows.length,
          safetyRows: snapshotState.currentSafetySnapshot
            ? Object.keys(snapshotState.currentSafetySnapshot).length
            : 0,
          reserveDriftIds: snapshotState.currentReserveDriftIds.length,
          chatsWithActiveSnooze,
          freezeOutboxState: freezeOutbox.state,
          freezeObserved: freezeOutbox.observed,
          freezeQueued: freezeOutbox.queued,
          freezeSkippedNoAudience: freezeOutbox.skippedNoAudience,
        },
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveAlertSourceState: snapshotState.reserveSourceAssessment.state,
        reserveAlertSourceAgeSeconds: snapshotState.reserveSourceAssessment.ageSeconds,
        reserveAlertSourceGeneration: snapshotState.reserveSourceAssessment.generation,
        safetyAlertSourceState: safetySourceAssessment.state,
        safetyAlertSourceAgeSeconds: safetySourceAssessment.ageSeconds,
        safetyAlertSourceGeneration: safetySourceAssessment.generation,
        deferredTail: pendingTailState(pendingCapacityBefore),
      },
    });

    const recovery = await recoverIncompleteTelegramSourceEvent({
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
    });
    if (recovery.kind === "handled") {
      return addTelegramDispatchMetadataCounters(
        { itemCount: recovery.itemCount, metadata: recovery.metadata },
        planningCounters,
      );
    }
    let sourceEvent = recovery.sourceEvent;
    const resumedSourceEvent = recovery.resumedSourceEvent;

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
      return addTelegramDispatchMetadataCounters(
        { itemCount: 0, metadata: JSON.stringify(result) },
        planningCounters,
      );
    }

    await reportCronProgress(reportProgress, {
      stage: "event-detection",
      message: "Detecting Telegram alert events",
      providerFamily: "telegram-dispatch",
      itemsDone: 0,
      itemsTotal: TELEGRAM_ALERT_PROVIDER_FAMILIES.length,
      metadata: {
        providerFamilies: TELEGRAM_ALERT_PROVIDER_FAMILIES,
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveAlertSourceState: snapshotState.reserveSourceAssessment.state,
      },
    });
    const dispatchEvents = sourceEvent?.events ?? await buildTelegramDispatchEvents(
      planningDb,
      sourceData,
      snapshotState,
      getSymbol,
      signal,
    );
    const eventSummary = summarizeTelegramDispatchEvents(dispatchEvents);
    const eventCount = eventSummary.total;

    const requiresFullFanoutPath = eventCount > 0 || sourceEvent != null;
    if (!sourceEvent && requiresFullFanoutPath) {
      sourceEvent = await persistTelegramAlertSourceEvent(
        planningDb,
        await buildTelegramAlertSourceEvent({
          events: dispatchEvents,
          baseline: currentSnapshots,
          detectedAt: nowSec,
        }),
        signal,
      );
    }
    await reportCronProgress(reportProgress, {
      stage: "event-detection-complete",
      message: "Completed Telegram alert event detection",
      providerFamily: "telegram-dispatch",
      itemsDone: eventCount,
      itemsTotal: Math.max(eventCount, 1),
      metadata: {
        providerFamilies: TELEGRAM_ALERT_PROVIDER_FAMILIES,
        countTotals: {
          ...eventSummary.transitionCounts,
          freezeObserved: freezeOutbox.observed,
          suppressedMethodologyChanges: dispatchEvents.suppressedMethodologyChanges,
        },
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveAlertSourceState: snapshotState.reserveSourceAssessment.state,
        sourceEventId: sourceEvent?.sourceEventId ?? null,
        resumedSourceEvent,
      },
    });

    const hasEvents = eventCount > 0;
    const canUseEventlessFastPath = !hasEvents && sourceEvent == null;

    if (canUseEventlessFastPath) {
      const result = await executeEventlessFastPath({
        db,
        botToken,
        currentSnapshots,
        reserveSourceUnavailable: snapshotState.reserveSourceUnavailable,
        reserveSourceAssessment: snapshotState.reserveSourceAssessment,
        safetySourceAssessment,
        safetySnapshotNeedsSeed,
        suppressedMethodologyChanges: dispatchEvents.suppressedMethodologyChanges,
        suppressedSafetyChangesAtSeed,
        pendingCapacityBefore,
        nowSec,
        dispatchStartedAtMs,
        chatsWithActiveSnooze,
        signal,
        sharedState,
        reportProgress,
        markTelegramDeliveryStarted,
      });
      return addTelegramDispatchMetadataCounters(
        { itemCount: result.messagesSent, metadata: JSON.stringify(result) },
        planningCounters,
      );
    }

    if (!sourceEvent) {
      throw new Error("Telegram alert events were not persisted before fanout");
    }

    const result = await executeFullFanoutPath({
      db: planningDb,
      botToken,
      snapshotState,
      events: dispatchEvents,
      sourceEvent,
      pendingCapacityBefore,
      suppressedSafetyChangesAtSeed,
      nowSec,
      dispatchStartedAtMs,
      chatsWithActiveSnooze,
      signal,
      sharedState,
      reportProgress,
      markTelegramDeliveryStarted,
    });

    return addTelegramDispatchMetadataCounters(
      { itemCount: result.messagesSent, metadata: JSON.stringify(result) },
      planningCounters,
    );
  } catch (error) {
    if (shouldRecordTelegramDispatchFailure(error, signal, telegramDeliveryStarted)) {
      await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
    }
    throw error;
  }
}

export async function dispatchTelegramAlerts(
  db: D1Database,
  botToken: string,
  signal?: AbortSignal,
  sharedState?: TelegramDispatchSharedState,
  reportProgress?: CronProgressReporter,
): Promise<{ itemCount: number; metadata: string }> {
  const startedAtMs = Date.now();
  assignSharedDispatchState(sharedState, {
    dispatchStartedAtMs: startedAtMs,
    dispatchCompleted: false,
    dispatchFailed: false,
    dispatchDurationMs: 0,
  });
  try {
    return await dispatchTelegramAlertsImpl(db, botToken, signal, sharedState, reportProgress);
  } catch (error) {
    assignSharedDispatchState(sharedState, { dispatchFailed: true });
    throw error;
  } finally {
    assignSharedDispatchState(sharedState, {
      dispatchCompleted: true,
      dispatchDurationMs: Math.max(0, Date.now() - startedAtMs),
    });
  }
}
