import { logCronEvent, type CronProgressReporter, type CronResult } from "../lib/cron-logger";
import { toErrorMessage } from "@shared/lib/error-utils";
import { raceWithTimeout } from "@shared/lib/timeout-signal";
import { STATUS_RESERVE_COMPOSITION_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { ReserveFeedReview } from "@shared/types/live-reserves";
import { throwIfAborted } from "../lib/abort";
import { matchReserveFeedReview, resolveReserveFeedReviews } from "../lib/reserve-feed-reviews";
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
  type ReserveSyncStateRecord,
} from "../lib/live-reserves/store";
import {
  LIVE_RESERVE_ARTIFACT_KEEP_COIN_IDS,
  CONFIGURED_LIVE_RESERVE_BREAKER_KEYS,
  type LiveReserveBreakerOutcome,
  type LiveReserveDeferredTailOutcome,
  type LiveReservePhaseTimings,
  type LiveReserveQueueCounts,
  type LiveReserveCohortGrading,
  type ReserveAttemptFailureSummary,
} from "./sync-live-reserves-shared";
import type { LiveReserveSyncBudgetConfig } from "./sync-live-reserves-config";
import type { AdapterLatencySummary, AdapterTelemetryProgress } from "./sync-live-reserves-core";
import { setLiveReserveCheckpointCohortGrading } from "../lib/scheduled-recovery-checkpoint";
import type { ScheduledCheckpointIdentity } from "../lib/scheduled-checkpoint-primitives";

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
  counts: LiveReserveQueueCounts;
  warningMessages: string[];
  coinsWithErrors: string[];
  coinsWithWarnings: string[];
  breaker: LiveReserveBreakerOutcome;
  deferredTail: LiveReserveDeferredTailOutcome;
  checkpointOwned: boolean;
  attemptFailureSummaries: ReserveSyncAttemptFailureGroup[];
  persistedFailures?: readonly ReserveSyncStateRecord[];
  budgetConfig: LiveReserveSyncBudgetConfig;
  phaseTimings: LiveReservePhaseTimings;
  cohortItemsDoneBeforeRun?: number;
  cohortGradingBeforeRun?: LiveReserveCohortGrading;
  checkpointIdentity?: ScheduledCheckpointIdentity;
  adapterLatency: AdapterLatencySummary;
  adapterTelemetryProgress: AdapterTelemetryProgress;
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
  breakerOutcomeWriteFailures: number;
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
    breakerOutcomeWriteFailures: 0,
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
    return (await getCircuitRecordsForSources(db, Array.from(outcomes.keys()))).records;
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
  const existingBreakerRecords = await loadBreakerRecordsForOutcomes(args.db, args.breaker.breakerOutcomes);
  const candidates: Array<[string, boolean]> = [];
  for (const [key, success] of args.breaker.breakerOutcomes) {
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
    const outcome = await recordOutcomeSafe(args.db, key, success);
    if (outcome !== null) {
      budget.breakerOutcomesRecorded++;
    } else {
      budget.breakerOutcomeWriteFailures++;
    }
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

// The coverage floor is shared with reserve health; circuit holds are not fetches.
const MAX_ADAPTER_FAILURE_RATIO = 1 - STATUS_RESERVE_COMPOSITION_THRESHOLDS.degradedFreshCoverageRatio;

function hasRequiredReserveSyncFailure(counts: LiveReserveQueueCounts): boolean {
  const attempted = counts.attemptedCoins - counts.circuitSkipped;
  return counts.persistenceFailed > 0
    || attempted - counts.failed < STATUS_RESERVE_COMPOSITION_THRESHOLDS.degradedFreshCoverageRatio * attempted;
}

export function resolveReserveSyncRunStatus(
  args: Pick<FinalizeReserveSyncRunArgs, "counts" | "total" | "checkpointOwned">,
): CronResult["status"] {
  const hasRequiredFailure = hasRequiredReserveSyncFailure(args.counts);
  if (args.checkpointOwned && !hasRequiredFailure && args.counts.circuitSkipped === 0) {
    // A bounded, checkpointed slice positively completed its admitted work.
    // Unadmitted suffix work is normal continuation, not an adapter failure.
    return "ok";
  }
  if (args.counts.synced === 0 && (args.counts.failed > 0 || args.counts.skipped > 0)) {
    // A run that synced nothing because the circuit breaker legitimately held
    // every candidate (no genuine failures, no budget-deferred tail) is healthy
    // recovery behavior, not an error. Surface it as "degraded" so alerting can
    // distinguish a quiet breaker from an all-adapters-failed run. "error" stays
    // reserved for real adapter/storage failures and the first-run-all-deferred
    // case (budget exhausted before anything could sync).
    if (args.counts.failed === 0 && args.counts.deferredSkipped === 0 && args.counts.circuitSkipped > 0) {
      return "degraded";
    }
    return "error";
  }
  if (!args.checkpointOwned && args.counts.deferredCoins > 0) return "degraded";
  return hasRequiredFailure || args.counts.circuitSkipped > 0 ? "degraded" : "ok";
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
      synced: args.counts.synced,
      failed: args.counts.failed,
      skipped: args.counts.skipped,
      adapterTelemetryProgress: args.adapterTelemetryProgress,
    },
  });

  throwIfAborted(args.signal);

  await recordBreakerOutcomesForRun(args, finalizationBudget);

  // Partial slices settle breaker outcomes but do not rescan/prune the same
  // cohort's durable artifacts. Exhaustion owns maintenance before the seal.
  const maintenanceDue = !args.checkpointOwned || args.counts.deferredCoins === 0;
  throwIfAborted(args.signal);
  try {
    if (maintenanceDue) {
      await recoverNoCandidateLiveReserveBreakers(
        args.db,
        args.signal,
        finalizationBudget,
        () => hasD1FinalizationWindow(args, finalizationBudget),
      );
    }
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
  if (maintenanceDue && hasD1FinalizationWindow(args, finalizationBudget)) {
    try {
      artifactCleanup = await cleanupStaleLiveReserveArtifacts(
        args.db,
        LIVE_RESERVE_ARTIFACT_KEEP_COIN_IDS,
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
  } else if (maintenanceDue) {
    finalizationBudget.artifactCleanupSkipped = true;
    artifactCleanupWarnings.push({
      eventType: "live-reserve-artifact-cleanup-skipped",
      message: "Ghost live-reserve artifact cleanup skipped because finalization tail budget was exhausted.",
      error: "finalization-tail-budget-exhausted",
    });
  }

  let historyPrune: Awaited<ReturnType<typeof pruneLiveReserveHistory>> | null = null;
  throwIfAborted(args.signal);
  if (maintenanceDue && hasD1FinalizationWindow(args, finalizationBudget)) {
    try {
      historyPrune = await pruneLiveReserveHistory(args.db, args.runStartedAt, {
        signal: args.signal,
        deadlineMs: finalizationBudget.deadlineMs - args.budgetConfig.finalizationMarginMs,
      });
    } catch (error) {
      await recordFinalizationWarning(
        args.db,
        "live-reserve-history-prune-failed",
        "Live reserve history prune failed.",
        error,
      );
    }
  } else if (maintenanceDue) {
    finalizationBudget.historyPruneSkipped = true;
    await recordFinalizationWarning(
      args.db,
      "live-reserve-history-prune-skipped",
      "Live reserve history prune skipped because finalization tail budget was exhausted.",
      new Error("finalization-tail-budget-exhausted"),
    );
  }

  finalizationBudget.remainingMs = Math.max(0, finalizationBudget.deadlineMs - Date.now());
  const reviews = resolveReserveFeedReviews(Math.floor(Date.now() / 1000));
  const acknowledgedFeeds: ReserveFeedReview[] = [];
  let acknowledgedFailed = 0;
  let acknowledgedCircuitSkipped = 0;
  for (const state of args.persistedFailures ?? []) {
    throwIfAborted(args.signal);
    if (!hasD1FinalizationWindow(args, finalizationBudget)) break;
    if (!reviews.activeById.has(state.stablecoinId)) continue;
    let review: ReserveFeedReview | null = null;
    try {
      review = await raceWithTimeout(
        matchReserveFeedReview(args.db, state, Math.floor(Date.now() / 1000), reviews.activeById),
        finalizationBudget.remainingMs - args.budgetConfig.finalizationMarginMs,
        "reserve-review-budget-exhausted",
      );
    } catch { /* Unreadable evidence cannot acknowledge a failed attempt. */ }
    if (!review || Date.now() / 1000 >= review.expiresAt || !hasD1FinalizationWindow(args, finalizationBudget)) continue;
    acknowledgedFeeds.push(review);
    if (state.lastStatus === "skipped") acknowledgedCircuitSkipped++;
    else acknowledgedFailed++;
  }
  const requiredCounts = {
    ...args.counts,
    failed: args.counts.failed - acknowledgedFailed,
    circuitSkipped: args.counts.circuitSkipped - acknowledgedCircuitSkipped,
    skipped: args.counts.skipped - acknowledgedCircuitSkipped,
    attemptedCoins: args.counts.attemptedCoins - acknowledgedFailed - acknowledgedCircuitSkipped,
  };
  const itemsDoneBeforeRun = args.cohortItemsDoneBeforeRun ?? 0;
  const previous = args.checkpointOwned && args.cohortGradingBeforeRun?.itemsDone === itemsDoneBeforeRun
    ? args.cohortGradingBeforeRun : undefined;
  const cohortGrading: LiveReserveCohortGrading = {
    itemsDone: itemsDoneBeforeRun + args.counts.attemptedCoins,
    complete: !args.checkpointOwned || itemsDoneBeforeRun === 0 || previous?.complete === true,
    synced: requiredCounts.synced + (previous?.synced ?? 0),
    failed: requiredCounts.failed + (previous?.failed ?? 0),
    persistenceFailed: requiredCounts.persistenceFailed + (previous?.persistenceFailed ?? 0),
    circuitSkipped: requiredCounts.circuitSkipped + (previous?.circuitSkipped ?? 0),
    attemptedCoins: requiredCounts.attemptedCoins + (previous?.attemptedCoins ?? 0),
  };
  const gradingCounts = { ...requiredCounts, ...cohortGrading,
    skipped: requiredCounts.skipped + (previous?.circuitSkipped ?? 0) };
  const hasRequiredFailure = !cohortGrading.complete || hasRequiredReserveSyncFailure(gradingCounts);
  const measuredStatus = resolveReserveSyncRunStatus({ ...args, counts: gradingCounts });
  const runStatus = !cohortGrading.complete && measuredStatus === "ok" ? "degraded" : measuredStatus;
  if (args.checkpointIdentity) {
    await setLiveReserveCheckpointCohortGrading(args.db, args.checkpointIdentity, cohortGrading);
  }
  const reasons = [
    ...(cohortGrading.failed > 0 || !cohortGrading.complete ? ["reserve-adapter-or-persistence-failed"] : []),
    ...(args.counts.deferredCoins > 0 || args.counts.deferredSkipped > 0
      ? [args.checkpointOwned ? "reserve-continuation-pending" : "reserve-run-budget-deferred"] : []),
    ...(cohortGrading.circuitSkipped > 0 ? ["reserve-circuit-open"] : []),
  ];

  return {
    itemCount: args.counts.synced,
    status: runStatus,
    productivity: { productive: args.counts.latestPublishedAt != null },
    metadata: JSON.stringify({
      maintenanceDeferredToCohortEnd: !maintenanceDue,
      ...(args.counts.latestPublishedAt != null ? { outputPublishedAt: args.counts.latestPublishedAt } : {}),
      ...(runStatus !== "ok"
        ? {
            reason: hasRequiredFailure
              ? "reserve-adapter-or-persistence-failed"
              : cohortGrading.circuitSkipped > 0
                ? "reserve-circuit-open"
                : args.checkpointOwned ? "reserve-continuation-pending" : "reserve-run-budget-deferred",
          }
        : {}),
      reasons,
      structureVersion: 2,
      synced: args.counts.synced,
      failed: args.counts.failed,
      persistenceFailed: args.counts.persistenceFailed,
      unacknowledgedFailed: requiredCounts.failed,
      unacknowledgedCircuitSkipped: requiredCounts.circuitSkipped,
      ...(args.checkpointOwned ? {
        cohortGrading: cohortGrading.complete ? cohortGrading : null,
        ...(!cohortGrading.complete ? { cohortGradingUnavailableReason: "checkpoint-grading-frontier-unavailable" } : {}),
      } : {}),
      adapterFailureBudget: {
        maxFailureRatio: MAX_ADAPTER_FAILURE_RATIO,
        attemptedFeeds: cohortGrading.complete ? cohortGrading.attemptedCoins - cohortGrading.circuitSkipped : null,
        failedFeeds: cohortGrading.complete ? cohortGrading.failed - cohortGrading.persistenceFailed : null,
      },
      ...(acknowledgedFeeds.length > 0 || (cohortGrading.failed > 0 && !hasRequiredFailure) ? { quality: {
        ...(cohortGrading.failed > 0 && !hasRequiredFailure
          ? { reasons: ["reserve-adapter-or-persistence-failed"] } : {}),
        ...(acknowledgedFeeds.length > 0 ? {
          reason: "reserve-feed-failure-reviewed",
          acknowledgedFeedIds: acknowledgedFeeds.map((review) => review.stablecoinId),
          acknowledgedFeeds,
        } : {}),
      } } : {}),
      skipped: args.counts.skipped,
      total: args.total,
      warningCount: args.warningMessages.length,
      runBudgetTruncated: args.counts.deferredCoins > 0 && !args.checkpointOwned,
      continuationPending: args.counts.deferredCoins > 0 && args.checkpointOwned,
      deferredCoins: args.counts.deferredCoins,
      nextCursorStablecoinId: args.deferredTail.nextCursorStablecoinId,
      deferredAt: args.deferredTail.cursorRecordedAt,
      cursorTailState: args.deferredTail.cursorTailState,
      cursorTailError: args.deferredTail.cursorTailError,
      cursorRecordedAt: args.deferredTail.cursorRecordedAt,
      cursorTailCompletedAt: args.deferredTail.cursorTailCompletedAt,
      cursorTailFailedAt: args.deferredTail.cursorTailFailedAt,
      runBudgetTruncationCount: args.deferredTail.runBudgetTruncationCount,
      budgetMs: args.budgetConfig.runBudgetMs,
      maxCoinsPerSlice: args.budgetConfig.maxCoinsPerSlice,
      adapterTimeoutMs: args.budgetConfig.adapterTimeoutMs,
      d1FinalizeTimeoutMs: args.budgetConfig.d1FinalizeTimeoutMs,
      finalizationMarginMs: args.budgetConfig.finalizationMarginMs,
      finalizationDeadlineMs: finalizationBudget.deadlineMs,
      finalizationRemainingMs: finalizationBudget.remainingMs,
      phaseTimingsMs: {
        setup: args.phaseTimings.setup,
        queue: args.phaseTimings.queue,
        adapter: args.phaseTimings.adapter,
        d1CoinPersistence: args.phaseTimings.d1CoinPersistence,
        stages: args.phaseTimings.stages,
        finalization: Date.now() - finalizationStartedMs,
      },
      adapterLatency: args.adapterLatency,
      attemptedCoins: args.counts.attemptedCoins,
      cohortItemsDoneBeforeRun: args.cohortItemsDoneBeforeRun ?? 0,
      cohortItemsDoneAfterRun:
        (args.cohortItemsDoneBeforeRun ?? 0)
        + args.counts.attemptedCoins,
      finalizationTailBudgetExhausted:
        finalizationBudget.breakerOutcomeBudgetExhausted
        || finalizationBudget.artifactCleanupSkipped
        || finalizationBudget.historyPruneSkipped,
      breakerOutcomesTotal: args.breaker.breakerOutcomes.size,
      breakerOutcomesRecorded: finalizationBudget.breakerOutcomesRecorded,
      breakerOutcomeWriteFailures: finalizationBudget.breakerOutcomeWriteFailures,
      breakerOutcomesSkippedBudget: finalizationBudget.breakerOutcomesSkippedBudget,
      breakerOutcomesSkippedClosedSuccess: finalizationBudget.breakerOutcomesSkippedClosedSuccess,
      breakerOutcomeBudgetExhausted: finalizationBudget.breakerOutcomeBudgetExhausted,
      staleBreakerRecoveriesSkipped: finalizationBudget.staleBreakerRecoveriesSkipped,
      artifactCleanupSkipped: finalizationBudget.artifactCleanupSkipped,
      historyPruneSkipped: finalizationBudget.historyPruneSkipped,
      ...(args.checkpointOwned
        ? { childDisposition: args.counts.deferredCoins > 0 ? "continuation_pending" : "completed" }
        : {}),
      artifactCleanup,
      artifactCleanupWarningCount: artifactCleanupWarnings.length,
      ...(artifactCleanupWarnings.length > 0 ? { artifactCleanupWarnings } : {}),
      ...(args.coinsWithWarnings.length > 0 ? { coinsWithWarnings: args.coinsWithWarnings } : {}),
      ...(args.coinsWithErrors.length > 0 ? { coinsWithErrors: args.coinsWithErrors } : {}),
      ...(args.attemptFailureSummaries.length > 0 ? { attemptFailureSummaries: args.attemptFailureSummaries } : {}),
      ...(args.warningMessages.length > 0 ? { warnings: args.warningMessages } : {}),
      ...(historyPrune ? { historyPrune } : {}),
      breakerKeys: Array.from(args.breaker.breakerKeys),
    }),
  };
}
