import { logCronEvent, type CronProgressReporter, type CronResult } from "../lib/cron-logger";
import { toErrorMessage } from "../lib/error-utils";
import { throwIfAborted } from "../lib/abort";
import {
  filterStaleLiveReserveCircuitStates,
  getCircuitRecordsForSources,
  getCircuitStates,
  recoverBreakerOnNoCandidate,
  recordOutcomeSafe,
  type CircuitRecord,
} from "../lib/circuit-breaker";
import { reportCronProgress } from "../lib/cron-progress";
import {
  cleanupStaleLiveReserveArtifacts,
  pruneLiveReserveHistory,
  type LiveReserveArtifactCleanupResult,
} from "../lib/live-reserves-store";
import {
  CONFIGURED_COINS,
  CONFIGURED_LIVE_RESERVE_BREAKER_KEYS,
  type ReserveAttemptFailureSummary,
} from "./sync-live-reserves-shared";
import {
  clearCursorStateIfComplete,
  type LiveReserveCursorTailState,
  type LoadedLiveReserveCursorState,
} from "./sync-live-reserves-run-state";
import type { LiveReserveSyncBudgetConfig } from "./sync-live-reserves-config";

export interface ReserveSyncAttemptFailureGroup {
  stablecoinId: string;
  adapter: string;
  attempts: ReserveAttemptFailureSummary[];
}

export interface FinalizeReserveSyncRunArgs {
  db: D1Database;
  signal?: AbortSignal;
  total: number;
  runStartedAt: number;
  runStartedMs: number;
  reportProgress?: CronProgressReporter;
  synced: number;
  failed: number;
  skipped: number;
  circuitSkipped: number;
  deferredSkipped: number;
  warningMessages: string[];
  coinsWithErrors: string[];
  coinsWithWarnings: string[];
  breakerKeys: ReadonlySet<string>;
  breakerOutcomes: ReadonlyMap<string, boolean>;
  deferredCoins: number;
  nextCursorStablecoinId: string | null;
  cursorTailState: LiveReserveCursorTailState | null;
  cursorRecordedAt: number | null;
  cursorTailCompletedAt: number | null;
  cursorTailFailedAt: number | null;
  cursorTailError: string | null;
  runBudgetTruncationCount: number;
  loadedCursorState: LoadedLiveReserveCursorState | null;
  attemptFailureSummaries: ReserveSyncAttemptFailureGroup[];
  budgetConfig: LiveReserveSyncBudgetConfig;
  setupPhaseMs?: number;
  queuePhaseMs?: number;
  cohortItemsDoneBeforeRun?: number;
  attemptedCoins?: number;
  adapterPhaseMs?: number;
  d1PhaseMs?: number;
}

interface LiveReserveFinalizationWarning {
  eventType: string;
  message: string;
  error: string;
}

interface LiveReserveFinalizationBudget {
  deadlineMs: number;
  remainingMs: number;
  breakerOutcomesRecorded: number;
  breakerOutcomesSkippedBudget: number;
  breakerOutcomesSkippedClosedSuccess: number;
  breakerOutcomeBudgetExhausted: boolean;
  staleBreakerRecoveriesSkipped: number;
  artifactCleanupSkipped: boolean;
  historyPruneSkipped: boolean;
}

function resolveFinalizationBudget(args: FinalizeReserveSyncRunArgs): LiveReserveFinalizationBudget {
  const deadlineMs = args.runStartedMs + args.budgetConfig.runBudgetMs + args.budgetConfig.d1FinalizeTimeoutMs;
  return {
    deadlineMs,
    remainingMs: Math.max(0, deadlineMs - Date.now()),
    breakerOutcomesRecorded: 0,
    breakerOutcomesSkippedBudget: 0,
    breakerOutcomesSkippedClosedSuccess: 0,
    breakerOutcomeBudgetExhausted: false,
    staleBreakerRecoveriesSkipped: 0,
    artifactCleanupSkipped: false,
    historyPruneSkipped: false,
  };
}

function hasD1FinalizationWindow(args: FinalizeReserveSyncRunArgs, budget: LiveReserveFinalizationBudget): boolean {
  budget.remainingMs = Math.max(0, budget.deadlineMs - Date.now());
  return budget.remainingMs > args.budgetConfig.finalizationMarginMs;
}

function shouldRecordBreakerOutcome(
  source: string,
  success: boolean,
  records: Record<string, CircuitRecord>,
): boolean {
  if (!success) return true;

  const current = records[source];
  return (
    !current
    || current.state !== "closed"
    || current.consecutiveFailures !== 0
    || current.lastSuccessAt == null
    || current.openedAt != null
  );
}

async function loadBreakerRecordsForOutcomes(
  db: D1Database,
  outcomes: ReadonlyMap<string, boolean>,
): Promise<Record<string, CircuitRecord>> {
  if (outcomes.size === 0) return {};
  try {
    return await getCircuitRecordsForSources(db, Array.from(outcomes.keys()));
  } catch (error) {
    await logCronEvent(db, {
      job: "sync-live-reserves",
      eventType: "live-reserve-breaker-bulk-read-failed",
      severity: "warning",
      message: "Failed to bulk-read live reserve breaker states; breaker finalization will fall back to per-outcome writes.",
      metadata: {
        error: toErrorMessage(error),
      },
    });
    return {};
  }
}

async function recordBreakerOutcomesForRun(
  args: FinalizeReserveSyncRunArgs,
  budget: LiveReserveFinalizationBudget,
): Promise<void> {
  const existingBreakerRecords = await loadBreakerRecordsForOutcomes(args.db, args.breakerOutcomes);
  const candidates: Array<[string, boolean]> = [];
  for (const [key, success] of args.breakerOutcomes) {
    if (shouldRecordBreakerOutcome(key, success, existingBreakerRecords)) {
      candidates.push([key, success]);
    } else {
      budget.breakerOutcomesSkippedClosedSuccess++;
    }
  }

  candidates.sort((left, right) => Number(left[1]) - Number(right[1]));

  for (let index = 0; index < candidates.length; index++) {
    throwIfAborted(args.signal);
    if (!hasD1FinalizationWindow(args, budget)) {
      budget.breakerOutcomeBudgetExhausted = true;
      budget.breakerOutcomesSkippedBudget += candidates.length - index;
      break;
    }

    const [key, success] = candidates[index]!;
    await recordOutcomeSafe(args.db, key, success);
    budget.breakerOutcomesRecorded++;
  }
}

async function recoverNoCandidateLiveReserveBreakers(
  db: D1Database,
  signal: AbortSignal | undefined,
  budget: LiveReserveFinalizationBudget,
  hasBudget: () => boolean,
): Promise<void> {
  if (!hasBudget()) {
    budget.staleBreakerRecoveriesSkipped++;
    return;
  }
  const circuits = await getCircuitStates(db);
  const configuredCircuits = filterStaleLiveReserveCircuitStates(circuits);
  for (const source of Object.keys(circuits)) {
    throwIfAborted(signal);
    if (!hasBudget()) {
      budget.staleBreakerRecoveriesSkipped++;
      break;
    }
    if (!source.startsWith("live-reserves:") || Object.prototype.hasOwnProperty.call(configuredCircuits, source)) {
      continue;
    }
    await recoverBreakerOnNoCandidate(db, source);
  }
}

async function persistCursorStateForRun(args: FinalizeReserveSyncRunArgs): Promise<{
  cursorPersistFailed: boolean;
  cursorPersistError: string | null;
}> {
  try {
    await clearCursorStateIfComplete(
      args.db,
      args.deferredCoins,
      args.nextCursorStablecoinId,
      args.signal,
    );
    return { cursorPersistFailed: false, cursorPersistError: null };
  } catch (error) {
    const cursorPersistError = toErrorMessage(error);
    await logCronEvent(args.db, {
      job: "sync-live-reserves",
      eventType: "live-reserve-cursor-finalize-failed",
      severity: "warning",
      message:
        args.deferredCoins > 0
          ? "Live reserve cursor persistence failed; the next run may restart from the previous cursor."
          : "Live reserve cursor cleanup failed; status may show the previous deferred tail until cleanup succeeds.",
      metadata: {
        deferredCoins: args.deferredCoins,
        nextCursorStablecoinId: args.nextCursorStablecoinId,
        error: cursorPersistError,
      },
    });
    return { cursorPersistFailed: true, cursorPersistError };
  }
}

function getHistoryWriteFailedCoins(warningMessages: readonly string[]): string[] {
  return Array.from(new Set(
    warningMessages
      .filter((message) => message.endsWith(":history-write-failed"))
      .map((message) => message.slice(0, -":history-write-failed".length)),
  ));
}

async function recordHistoryWriteGapEvent(db: D1Database, historyWriteFailedCoins: readonly string[]): Promise<void> {
  if (historyWriteFailedCoins.length === 0) return;

  await logCronEvent(db, {
    job: "sync-live-reserves",
    eventType: "live-reserve-history-write-failed",
    severity: "warning",
    message:
      `${historyWriteFailedCoins.length} live reserve successful attempt(s) missed history writes after authoritative state was recorded.`,
    metadata: {
      coins: historyWriteFailedCoins,
    },
  });
}

async function recordFinalizationWarning(
  db: D1Database,
  eventType: string,
  message: string,
  error: unknown,
): Promise<LiveReserveFinalizationWarning> {
  const errorMessage = toErrorMessage(error);
  await logCronEvent(db, {
    job: "sync-live-reserves",
    eventType,
    severity: "warning",
    message,
    metadata: {
      error: errorMessage,
    },
  });
  return { eventType, message, error: errorMessage };
}

function resolveRunStatus(args: FinalizeReserveSyncRunArgs): CronResult["status"] {
  if (args.synced === 0 && (args.failed > 0 || args.skipped > 0)) {
    // A run that synced nothing because the circuit breaker legitimately held
    // every candidate (no genuine failures, no budget-deferred tail) is healthy
    // recovery behavior, not an error. Surface it as "degraded" so alerting can
    // distinguish a quiet breaker from an all-adapters-failed run. "error" stays
    // reserved for real adapter/storage failures and the first-run-all-deferred
    // case (budget exhausted before anything could sync).
    if (args.failed === 0 && args.deferredSkipped === 0 && args.circuitSkipped > 0) {
      return "degraded";
    }
    return "error";
  }
  return (args.failed + args.skipped) > Math.ceil(args.total * 0.1) ? "degraded" : "ok";
}

export async function finalizeReserveSyncRun(args: FinalizeReserveSyncRunArgs): Promise<CronResult> {
  const finalizationStartedMs = Date.now();
  const finalizationBudget = resolveFinalizationBudget(args);

  await reportCronProgress(args.reportProgress, {
    stage: "finalizing",
    message: "Recording reserve sync outcomes and cleanup",
    itemsDone: args.total,
    itemsTotal: args.total,
    metadata: {
      synced: args.synced,
      failed: args.failed,
      skipped: args.skipped,
    },
  });

  throwIfAborted(args.signal);
  const { cursorPersistFailed, cursorPersistError } = await persistCursorStateForRun(args);

  throwIfAborted(args.signal);
  await recordBreakerOutcomesForRun(args, finalizationBudget);

  throwIfAborted(args.signal);
  try {
    await recoverNoCandidateLiveReserveBreakers(
      args.db,
      args.signal,
      finalizationBudget,
      () => hasD1FinalizationWindow(args, finalizationBudget),
    );
  } catch (error) {
    await recordFinalizationWarning(
      args.db,
      "live-reserve-breaker-recovery-failed",
      "Failed to recover stale live-reserve circuit breakers.",
      error,
    );
  }

  let artifactCleanup: LiveReserveArtifactCleanupResult | null = null;
  const artifactCleanupWarnings: LiveReserveFinalizationWarning[] = [];
  throwIfAborted(args.signal);
  if (hasD1FinalizationWindow(args, finalizationBudget)) {
    try {
      artifactCleanup = await cleanupStaleLiveReserveArtifacts(
        args.db,
        CONFIGURED_COINS.map((coin) => coin.id),
        CONFIGURED_LIVE_RESERVE_BREAKER_KEYS,
      );
    } catch (error) {
      artifactCleanupWarnings.push(
        await recordFinalizationWarning(
          args.db,
          "live-reserve-artifact-cleanup-failed",
          "Ghost live-reserve artifact cleanup failed.",
          error,
        ),
      );
    }
  } else {
    finalizationBudget.artifactCleanupSkipped = true;
    artifactCleanupWarnings.push({
      eventType: "live-reserve-artifact-cleanup-skipped",
      message: "Ghost live-reserve artifact cleanup skipped because finalization tail budget was exhausted.",
      error: "finalization-tail-budget-exhausted",
    });
  }

  let historyPrune: Awaited<ReturnType<typeof pruneLiveReserveHistory>> | null = null;
  throwIfAborted(args.signal);
  if (hasD1FinalizationWindow(args, finalizationBudget)) {
    try {
      historyPrune = await pruneLiveReserveHistory(args.db, args.runStartedAt);
    } catch (error) {
      await recordFinalizationWarning(
        args.db,
        "live-reserve-history-prune-failed",
        "Live reserve history prune failed.",
        error,
      );
    }
  } else {
    finalizationBudget.historyPruneSkipped = true;
    await recordFinalizationWarning(
      args.db,
      "live-reserve-history-prune-skipped",
      "Live reserve history prune skipped because finalization tail budget was exhausted.",
      new Error("finalization-tail-budget-exhausted"),
    );
  }

  const historyWriteFailedCoins = getHistoryWriteFailedCoins(args.warningMessages);
  await recordHistoryWriteGapEvent(args.db, historyWriteFailedCoins);
  finalizationBudget.remainingMs = Math.max(0, finalizationBudget.deadlineMs - Date.now());

  return {
    itemCount: args.synced,
    status: resolveRunStatus(args),
    metadata: JSON.stringify({
      structureVersion: 2,
      synced: args.synced,
      failed: args.failed,
      skipped: args.skipped,
      total: args.total,
      warningCount: args.warningMessages.length,
      runBudgetTruncated: args.deferredCoins > 0,
      deferredCoins: args.deferredCoins,
      nextCursorStablecoinId: args.nextCursorStablecoinId,
      deferredAt: args.cursorRecordedAt,
      cursorTailState: args.cursorTailState,
      cursorTailError: args.cursorTailError,
      cursorRecordedAt: args.cursorRecordedAt,
      cursorTailCompletedAt: args.cursorTailCompletedAt,
      cursorTailFailedAt: args.cursorTailFailedAt,
      runBudgetTruncationCount: args.runBudgetTruncationCount,
      loadedCursorNextStablecoinId: args.loadedCursorState?.nextStablecoinId ?? null,
      loadedCursorTailState: args.loadedCursorState?.tailState ?? null,
      loadedCursorDeferredAt: args.loadedCursorState?.deferredAt ?? null,
      loadedCursorTruncationCount: args.loadedCursorState?.runBudgetTruncationCount ?? 0,
      budgetMs: args.budgetConfig.runBudgetMs,
      adapterTimeoutMs: args.budgetConfig.adapterTimeoutMs,
      d1FinalizeTimeoutMs: args.budgetConfig.d1FinalizeTimeoutMs,
      finalizationMarginMs: args.budgetConfig.finalizationMarginMs,
      finalizationDeadlineMs: finalizationBudget.deadlineMs,
      finalizationRemainingMs: finalizationBudget.remainingMs,
      phaseTimingsMs: {
        setup: args.setupPhaseMs ?? 0,
        queue: args.queuePhaseMs ?? 0,
        adapter: args.adapterPhaseMs ?? 0,
        d1CoinPersistence: args.d1PhaseMs ?? 0,
        finalization: Date.now() - finalizationStartedMs,
      },
      attemptedCoins: args.attemptedCoins ?? args.synced + args.failed + args.circuitSkipped,
      cohortItemsDoneBeforeRun: args.cohortItemsDoneBeforeRun ?? 0,
      cohortItemsDoneAfterRun:
        (args.cohortItemsDoneBeforeRun ?? 0)
        + (args.attemptedCoins ?? args.synced + args.failed + args.circuitSkipped),
      finalizationTailBudgetExhausted:
        finalizationBudget.breakerOutcomeBudgetExhausted
        || finalizationBudget.artifactCleanupSkipped
        || finalizationBudget.historyPruneSkipped,
      breakerOutcomesTotal: args.breakerOutcomes.size,
      breakerOutcomesRecorded: finalizationBudget.breakerOutcomesRecorded,
      breakerOutcomesSkippedBudget: finalizationBudget.breakerOutcomesSkippedBudget,
      breakerOutcomesSkippedClosedSuccess: finalizationBudget.breakerOutcomesSkippedClosedSuccess,
      breakerOutcomeBudgetExhausted: finalizationBudget.breakerOutcomeBudgetExhausted,
      staleBreakerRecoveriesSkipped: finalizationBudget.staleBreakerRecoveriesSkipped,
      artifactCleanupSkipped: finalizationBudget.artifactCleanupSkipped,
      historyPruneSkipped: finalizationBudget.historyPruneSkipped,
      cursorPersistFailed,
      artifactCleanup,
      artifactCleanupWarningCount: artifactCleanupWarnings.length,
      ...(cursorPersistError ? { cursorPersistError } : {}),
      ...(artifactCleanupWarnings.length > 0 ? { artifactCleanupWarnings } : {}),
      ...(historyWriteFailedCoins.length > 0 ? { historyWriteFailedCoins } : {}),
      ...(args.coinsWithWarnings.length > 0 ? { coinsWithWarnings: args.coinsWithWarnings } : {}),
      ...(args.coinsWithErrors.length > 0 ? { coinsWithErrors: args.coinsWithErrors } : {}),
      ...(args.attemptFailureSummaries.length > 0 ? { attemptFailureSummaries: args.attemptFailureSummaries } : {}),
      ...(args.warningMessages.length > 0 ? { warnings: args.warningMessages } : {}),
      ...(historyPrune ? { historyPrune } : {}),
      breakerKeys: Array.from(args.breakerKeys),
    }),
  };
}
