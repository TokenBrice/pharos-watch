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
import { readTelegramPendingCapacitySnapshot } from "../lib/telegram/pending-capacity";
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
// The twelve-table planning pipeline named by the Sep-3 4.1 decision rule.
// Reads are useful diagnostics, but only rows actually written to these
// tables count toward the planning-share numerator.
const TELEGRAM_PLANNING_TABLES = [
  "telegram_alert_source_events",
  "telegram_alert_source_resolution_memberships",
  "telegram_alert_source_resolution_pages",
  "telegram_alert_source_resolution_targets",
  "telegram_alert_planning_subscribers",
  "telegram_alert_target_plans",
  "telegram_alert_target_plan_pages",
  "telegram_alert_target_plan_items",
  "telegram_alert_jobs",
  "telegram_alert_job_targets",
  "telegram_alert_job_target_items",
  "telegram_alert_target_expiry_progress",
] as const;


function telegramPlanningWriteTarget(sql: string): string | null {
  const normalizedSql = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const targetMatch = normalizedSql.match(
    /^(?:insert(?:\s+or\s+(?:replace|rollback|abort|fail|ignore))?|replace)\s+into\s+["`]?([a-z0-9_]+)["`]?/,
  ) ?? normalizedSql.match(
    /^update(?:\s+or\s+(?:replace|rollback|abort|fail|ignore))?\s+["`]?([a-z0-9_]+)["`]?/,
  ) ?? normalizedSql.match(
    /^delete\s+from\s+["`]?([a-z0-9_]+)["`]?/,
  );
  const target = targetMatch?.[1];
  return target && TELEGRAM_PLANNING_TABLES.includes(target as (typeof TELEGRAM_PLANNING_TABLES)[number])
    ? target
    : null;
}

type D1ResponseWithRowsWritten = {
  // D1 rows_written includes index writes; changes only counts affected logical
  // rows and is intentionally not a substitute for this measurement.
  meta?: { rows_written?: unknown } | null;
};

interface TelegramPlanningWriteCounters {
  planningRowsWritten: number;
  d1RowsWritten: number;
  planningRowsWrittenAvailable: boolean;
  d1RowsWrittenAvailable: boolean;
}

interface CountedTelegramStatement {
  statement: D1PreparedStatement;
  planningStatement: boolean;
}

const COUNTED_STATEMENT_ORIGINALS = new WeakMap<object, CountedTelegramStatement>();

function addRowsWritten(
  counters: TelegramPlanningWriteCounters,
  planningStatement: boolean,
  result: D1ResponseWithRowsWritten | null | undefined,
): void {
  const rowsWrittenValue = result?.meta?.rows_written;
  if (typeof rowsWrittenValue !== "number" || !Number.isFinite(rowsWrittenValue) || rowsWrittenValue < 0) {
    counters.d1RowsWrittenAvailable = false;
    if (planningStatement) counters.planningRowsWrittenAvailable = false;
    return;
  }
  const rowsWritten = Math.floor(rowsWrittenValue);
  counters.d1RowsWritten += rowsWritten;
  if (planningStatement) counters.planningRowsWritten += rowsWritten;
}

function createTelegramPlanningStatement(
  statement: D1PreparedStatement,
  planningStatement: boolean,
  counters: TelegramPlanningWriteCounters,
): D1PreparedStatement {
  const counted = {
    bind: (...values: unknown[]) =>
      createTelegramPlanningStatement(statement.bind(...values), planningStatement, counters),
    first: (...args: unknown[]) =>
      (statement.first as unknown as (...firstArgs: unknown[]) => Promise<unknown>).apply(statement, args),
    all: async (...args: unknown[]) => {
      const result = await (statement.all as unknown as (...allArgs: unknown[]) => Promise<D1ResponseWithRowsWritten>)
        .apply(statement, args);
      addRowsWritten(counters, planningStatement, result);
      return result;
    },
    run: async (...args: unknown[]) => {
      const result = await (statement.run as unknown as (...runArgs: unknown[]) => Promise<D1ResponseWithRowsWritten>)
        .apply(statement, args);
      addRowsWritten(counters, planningStatement, result);
      return result;
    },
    raw: (...args: unknown[]) =>
      (statement.raw as unknown as (...rawArgs: unknown[]) => Promise<unknown>).apply(statement, args),
  } as unknown as D1PreparedStatement;
  COUNTED_STATEMENT_ORIGINALS.set(counted, { statement, planningStatement });
  return counted;
}

function createTelegramPlanningDatabase(
  db: D1Database,
  counters: TelegramPlanningWriteCounters,
): D1Database {
  const countedDb = {
    ...db,
    prepare(sql: string) {
      return createTelegramPlanningStatement(
        db.prepare(sql),
        telegramPlanningWriteTarget(sql) != null,
        counters,
      );
    },
    async batch(statements: D1PreparedStatement[]) {
      const records = statements.map((statement) => COUNTED_STATEMENT_ORIGINALS.get(statement));
      const originals = statements.map((statement, index) => records[index]?.statement ?? statement);
      const results = await db.batch(originals);
      records.forEach((record, index) => {
        if (record) addRowsWritten(counters, record.planningStatement, results[index]);
      });
      return results;
    },
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
  counters: TelegramPlanningWriteCounters,
): { itemCount: number; metadata: string } {
  const metadata = parseTelegramDispatchMetadata(result.metadata);
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

  return {
    ...result,
    metadata: JSON.stringify({
      ...metadata,
      planningRowsWritten: counters.planningRowsWrittenAvailable
        ? Math.max(0, Math.floor(counters.planningRowsWritten))
        : null,
      d1RowsWritten: counters.d1RowsWrittenAvailable
        ? Math.max(0, Math.floor(counters.d1RowsWritten))
        : null,
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
  const planningCounters: TelegramPlanningWriteCounters = {
    planningRowsWritten: 0,
    d1RowsWritten: 0,
    planningRowsWrittenAvailable: true,
    d1RowsWrittenAvailable: true,
  };
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
    const sourceData = await loadDispatchSourceData(planningDb);
    const { chatsWithActiveSnooze } = sourceData;

    // Freeze events use a dedicated durable outbox because the historical
    // generic target-plan table is intentionally constrained to five families.
    const freezeOutbox = await dispatchFreezeAlertOutbox(planningDb, dispatchNowSec);

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
    const pendingCapacityBefore = await readTelegramPendingCapacitySnapshot(planningDb, nowSec);
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
      db: planningDb,
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
        db: planningDb,
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
        db: planningDb,
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
