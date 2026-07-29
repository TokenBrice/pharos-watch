import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import type {
  DexSourcePaginationState,
  DexSourcePaginationWriteOutcome,
} from "../dex-liquidity/source-pagination-state";

export interface NativeMeasuredExecutionSyncTarget {
  targetId: string;
  adapterProfileId: string;
}

export interface NativeMeasuredExecutionTargetGeneration<
  TTarget extends NativeMeasuredExecutionSyncTarget,
> {
  generationId: string;
  targets: TTarget[];
}

export type NativeMeasuredExecutionQuoteOutcome<
  TTarget extends NativeMeasuredExecutionSyncTarget,
  TProfile,
> =
  | { target: TTarget; status: "measured"; profile: TProfile }
  | {
      target: TTarget;
      status: "failed";
      failureReason: string;
      rawPayload: {
        adapterProfileId: string;
        targetId: string;
        failureReason: string;
      };
    };

export interface NativeMeasuredExecutionAdmission<
  TTarget extends NativeMeasuredExecutionSyncTarget,
  TMetadata,
> {
  admitted: Set<string>;
  orderedTargets: TTarget[];
  nextCursor: string | null;
  cursorPagesFetched: number;
  metadata: TMetadata;
}

interface NativeMeasuredExecutionQuoteState<
  TTarget extends NativeMeasuredExecutionSyncTarget,
  TProfile,
> {
  target: TTarget;
  profile: TProfile | null;
  failureReason: string | null;
}

interface NativeMeasuredExecutionSyncSummary<
  TTarget extends NativeMeasuredExecutionSyncTarget,
  TProfile,
  TMetadata,
> {
  targetGeneration: NativeMeasuredExecutionTargetGeneration<TTarget>;
  admission: NativeMeasuredExecutionAdmission<TTarget, TMetadata>;
  outcomes: NativeMeasuredExecutionQuoteOutcome<TTarget, TProfile>[];
  attemptedFailureCount: number;
  deferredCount: number;
  stopped: boolean;
  stoppedDeferredCount: number;
  admissionCursor: string | null;
  nextAdmissionCursor: string | null;
  cursorWriteStatus: "not-needed" | "written" | "missing-table" | "write-failed";
}

export interface NativeMeasuredExecutionSyncAdapter<
  TTarget extends NativeMeasuredExecutionSyncTarget,
  TProfile,
  TCredential,
  TAdmissionMetadata,
  TTargetGeneration extends NativeMeasuredExecutionTargetGeneration<TTarget>,
> {
  runtimeBudgetMs: number;
  missingTargetReason: string;
  missingTargetActivation: string;
  progressStage: string;
  progressMessage: string;
  productivityPublishedReason: string;
  productivityEmptyReason: string;
  loadTargetGeneration(db: D1Database, signal?: AbortSignal): Promise<TTargetGeneration | null>;
  readCursor(db: D1Database): Promise<DexSourcePaginationState>;
  admit(
    targets: readonly TTarget[],
    cursor: string | null,
  ): NativeMeasuredExecutionAdmission<TTarget, TAdmissionMetadata>;
  getActivation(targets: readonly TTarget[]): string;
  buildQuoteGenerationId(startedAt: number): string;
  measureTarget(input: {
    target: TTarget;
    targetGenerationId: string;
    quoteGenerationId: string;
    credential?: TCredential | null;
    deadlineMs: number;
    signal?: AbortSignal;
  }): Promise<TProfile>;
  normalizeFailure(error: unknown): string;
  shouldStopAfterFailure?(failureReason: string): boolean;
  stoppedDeferredReason?: string;
  publish(input: {
    db: D1Database;
    targetGeneration: TTargetGeneration;
    outcomes: readonly NativeMeasuredExecutionQuoteOutcome<TTarget, TProfile>[];
    quotedAt: number;
    generationId: string;
    signal?: AbortSignal;
  }): Promise<{ generationId: string; measuredCount: number; failedCount: number }>;
  writeCursor(input: {
    db: D1Database;
    cursor: string;
    cycleStartedAt: number;
    nowSec: number;
    pagesFetched: number;
    deferredCount: number;
    targetGenerationId: string;
  }): Promise<DexSourcePaginationWriteOutcome>;
  buildMetadata(
    summary: NativeMeasuredExecutionSyncSummary<TTarget, TProfile, TAdmissionMetadata>,
  ): Record<string, unknown>;
  shouldDegrade(
    summary: NativeMeasuredExecutionSyncSummary<TTarget, TProfile, TAdmissionMetadata>,
  ): boolean;
}

function aggregateNativeMeasuredExecutionFailures<
  TTarget extends NativeMeasuredExecutionSyncTarget,
  TProfile,
>(
  outcomes: readonly NativeMeasuredExecutionQuoteOutcome<TTarget, TProfile>[],
): Record<string, number> {
  return outcomes.reduce<Record<string, number>>((counts, outcome) => {
    if (outcome.status === "failed") {
      counts[outcome.failureReason] = (counts[outcome.failureReason] ?? 0) + 1;
    }
    return counts;
  }, {});
}

export async function syncNativeMeasuredExecution<
  TTarget extends NativeMeasuredExecutionSyncTarget,
  TProfile,
  TCredential,
  TAdmissionMetadata,
  TTargetGeneration extends NativeMeasuredExecutionTargetGeneration<TTarget>,
>(input: {
  db: D1Database;
  credential?: TCredential | null;
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
  adapter: NativeMeasuredExecutionSyncAdapter<
    TTarget,
    TProfile,
    TCredential,
    TAdmissionMetadata,
    TTargetGeneration
  >;
}): Promise<CronResult> {
  const startedAt = Math.floor(Date.now() / 1_000);
  const deadlineMs = Date.now() + input.adapter.runtimeBudgetMs;
  const deadlineSignal = AbortSignal.timeout(input.adapter.runtimeBudgetMs);
  const producerSignal = input.signal ? AbortSignal.any([input.signal, deadlineSignal]) : deadlineSignal;
  const targetGeneration = await input.adapter.loadTargetGeneration(input.db, input.signal);
  if (!targetGeneration || targetGeneration.targets.length === 0) {
    return {
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: input.adapter.missingTargetReason,
        activation: input.adapter.missingTargetActivation,
      }),
      productivity: { productive: false, reason: input.adapter.missingTargetReason },
    };
  }

  const activation = input.adapter.getActivation(targetGeneration.targets);
  const admissionState = await input.adapter.readCursor(input.db);
  const admissionCursor = admissionState.cursor?.trim() || null;
  const admission = input.adapter.admit(targetGeneration.targets, admissionCursor);
  const quoteGenerationId = input.adapter.buildQuoteGenerationId(startedAt);
  const states: NativeMeasuredExecutionQuoteState<TTarget, TProfile>[] =
    targetGeneration.targets.map((target) => ({
      target,
      profile: null,
      failureReason: admission.admitted.has(target.targetId) ? null : "budget-deferred",
    }));
  const stateByTargetId = new Map(states.map((state) => [state.target.targetId, state] as const));

  let completed = 0;
  let stopped = false;
  let lastAttemptedTargetId: string | null = null;
  for (const target of admission.orderedTargets) {
    const state = stateByTargetId.get(target.targetId)!;
    throwIfAborted(input.signal);
    lastAttemptedTargetId = target.targetId;
    try {
      state.profile = await input.adapter.measureTarget({
        target,
        targetGenerationId: targetGeneration.generationId,
        quoteGenerationId,
        credential: input.credential,
        deadlineMs,
        signal: producerSignal,
      });
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      state.failureReason = input.adapter.normalizeFailure(error);
      stopped = input.adapter.shouldStopAfterFailure?.(state.failureReason) === true;
    }
    completed++;
    await input.reportProgress?.({
      stage: input.adapter.progressStage,
      message: input.adapter.progressMessage,
      itemsDone: completed,
      itemsTotal: admission.admitted.size,
      metadata: { activation, targetGenerationId: targetGeneration.generationId },
    });
    if (stopped) break;
  }
  if (stopped && input.adapter.stoppedDeferredReason) {
    for (const state of states) {
      if (admission.admitted.has(state.target.targetId) && !state.profile && state.failureReason == null) {
        state.failureReason = input.adapter.stoppedDeferredReason;
      }
    }
  }

  const outcomes: NativeMeasuredExecutionQuoteOutcome<TTarget, TProfile>[] = states.map((state) =>
    state.profile
      ? { target: state.target, status: "measured", profile: state.profile }
      : {
          target: state.target,
          status: "failed",
          failureReason: state.failureReason ?? "quote-failed",
          rawPayload: {
            adapterProfileId: state.target.adapterProfileId,
            targetId: state.target.targetId,
            failureReason: state.failureReason ?? "quote-failed",
          },
        },
  );
  const publishedAt = Math.floor(Date.now() / 1_000);
  const publication = await input.adapter.publish({
    db: input.db,
    targetGeneration,
    outcomes,
    quotedAt: publishedAt,
    generationId: quoteGenerationId,
    signal: input.signal,
  });

  const deferredCount = targetGeneration.targets.length - admission.admitted.size;
  const stoppedDeferredCount = input.adapter.stoppedDeferredReason
    ? states.filter((state) => state.failureReason === input.adapter.stoppedDeferredReason).length
    : 0;
  const nextAdmissionCursor = stopped ? lastAttemptedTargetId : admission.nextCursor;
  let cursorWriteStatus: NativeMeasuredExecutionSyncSummary<
    TTarget,
    TProfile,
    TAdmissionMetadata
  >["cursorWriteStatus"] = "not-needed";
  if ((deferredCount > 0 || stopped) && nextAdmissionCursor) {
    const cursorWrite = await input.adapter.writeCursor({
      db: input.db,
      cursor: nextAdmissionCursor,
      cycleStartedAt: admissionState.cycleStartedAt ?? startedAt,
      nowSec: publishedAt,
      pagesFetched: admission.cursorPagesFetched,
      deferredCount,
      targetGenerationId: targetGeneration.generationId,
    });
    cursorWriteStatus = cursorWrite.written
      ? "written"
      : cursorWrite.errorClass === "not-configured"
        ? "write-failed"
        : cursorWrite.errorClass;
  }
  const attemptedFailureCount = states.filter(
    (state) =>
      admission.admitted.has(state.target.targetId) &&
      !state.profile &&
      state.failureReason !== input.adapter.stoppedDeferredReason,
  ).length;
  const summary: NativeMeasuredExecutionSyncSummary<TTarget, TProfile, TAdmissionMetadata> = {
    targetGeneration,
    admission,
    outcomes,
    attemptedFailureCount,
    deferredCount,
    stopped,
    stoppedDeferredCount,
    admissionCursor,
    nextAdmissionCursor,
    cursorWriteStatus,
  };
  const metadata = {
    activation,
    targetGenerationId: targetGeneration.generationId,
    quoteGenerationId: publication.generationId,
    targetCount: targetGeneration.targets.length,
    measuredCount: publication.measuredCount,
    failedCount: publication.failedCount,
    attemptedFailureCount,
    deferredCount,
    admissionCursor,
    nextAdmissionCursor,
    cursorWriteStatus,
    failuresByReason: aggregateNativeMeasuredExecutionFailures(outcomes),
    ...input.adapter.buildMetadata(summary),
  };
  return {
    status:
      attemptedFailureCount > 0 ||
      cursorWriteStatus === "write-failed" ||
      input.adapter.shouldDegrade(summary)
        ? "degraded"
        : "ok",
    itemCount: publication.measuredCount,
    metadata: JSON.stringify(metadata),
    productivity: {
      productive: publication.measuredCount > 0,
      reason:
        publication.measuredCount > 0
          ? input.adapter.productivityPublishedReason
          : input.adapter.productivityEmptyReason,
    },
  };
}
