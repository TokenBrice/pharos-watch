import { logCronEvent, type CronProgressReporter, type CronResult } from "../lib/cron-logger";
import {
  filterStaleLiveReserveCircuitStates,
  getCircuitStates,
  recoverBreakerOnNoCandidate,
  recordOutcomeSafe,
} from "../lib/circuit-breaker";
import { reportCronProgress } from "../lib/cron-progress";
import {
  cleanupStaleLiveReserveArtifacts,
  pruneLiveReserveHistory,
} from "../lib/live-reserves-store";
import {
  CONFIGURED_COINS,
  type ReserveAttemptFailureSummary,
} from "./sync-live-reserves-shared";
import { persistLiveReserveCursorState } from "./sync-live-reserves-run-state";
import type { LiveReserveSyncBudgetConfig } from "./sync-live-reserves-config";

export interface ReserveSyncAttemptFailureGroup {
  stablecoinId: string;
  adapter: string;
  attempts: ReserveAttemptFailureSummary[];
}

export interface FinalizeReserveSyncRunArgs {
  db: D1Database;
  total: number;
  runStartedAt: number;
  reportProgress?: CronProgressReporter;
  synced: number;
  failed: number;
  skipped: number;
  warningMessages: string[];
  coinsWithErrors: string[];
  coinsWithWarnings: string[];
  breakerKeys: ReadonlySet<string>;
  breakerOutcomes: ReadonlyMap<string, boolean>;
  deferredCoins: number;
  nextCursorStablecoinId: string | null;
  attemptFailureSummaries: ReserveSyncAttemptFailureGroup[];
  budgetConfig: LiveReserveSyncBudgetConfig;
}

async function recoverNoCandidateLiveReserveBreakers(db: D1Database): Promise<void> {
  const circuits = await getCircuitStates(db);
  const configuredCircuits = filterStaleLiveReserveCircuitStates(circuits);
  for (const source of Object.keys(circuits)) {
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
    await persistLiveReserveCursorState(
      args.db,
      args.deferredCoins,
      args.nextCursorStablecoinId,
    );
    return { cursorPersistFailed: false, cursorPersistError: null };
  } catch (error) {
    const cursorPersistError = error instanceof Error ? error.message : String(error);
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
): Promise<void> {
  await logCronEvent(db, {
    job: "sync-live-reserves",
    eventType,
    severity: "warning",
    message,
    metadata: {
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

function resolveRunStatus(args: FinalizeReserveSyncRunArgs): CronResult["status"] {
  if (args.synced === 0 && (args.failed > 0 || args.skipped > 0)) return "error";
  return (args.failed + args.skipped) > Math.ceil(args.total * 0.1) ? "degraded" : "ok";
}

export async function finalizeReserveSyncRun(args: FinalizeReserveSyncRunArgs): Promise<CronResult> {
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

  for (const [key, success] of args.breakerOutcomes) {
    await recordOutcomeSafe(args.db, key, success);
  }

  try {
    await recoverNoCandidateLiveReserveBreakers(args.db);
  } catch (error) {
    await recordFinalizationWarning(
      args.db,
      "live-reserve-breaker-recovery-failed",
      "Failed to recover stale live-reserve circuit breakers.",
      error,
    );
  }

  try {
    await cleanupStaleLiveReserveArtifacts(
      args.db,
      CONFIGURED_COINS.map((coin) => coin.id),
      args.breakerKeys,
    );
  } catch (error) {
    await recordFinalizationWarning(
      args.db,
      "live-reserve-artifact-cleanup-failed",
      "Ghost live-reserve artifact cleanup failed.",
      error,
    );
  }

  const { cursorPersistFailed, cursorPersistError } = await persistCursorStateForRun(args);
  let historyPrune: Awaited<ReturnType<typeof pruneLiveReserveHistory>> | null = null;
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

  const historyWriteFailedCoins = getHistoryWriteFailedCoins(args.warningMessages);
  await recordHistoryWriteGapEvent(args.db, historyWriteFailedCoins);

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
      budgetMs: args.budgetConfig.runBudgetMs,
      adapterTimeoutMs: args.budgetConfig.adapterTimeoutMs,
      d1FinalizeTimeoutMs: args.budgetConfig.d1FinalizeTimeoutMs,
      finalizationMarginMs: args.budgetConfig.finalizationMarginMs,
      cursorPersistFailed,
      ...(cursorPersistError ? { cursorPersistError } : {}),
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
