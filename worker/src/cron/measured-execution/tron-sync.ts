import { getDexMeasuredExecutionProbeNotionals } from "@shared/types/measured-execution";
import {
  validateTronMeasuredExecutionProfile,
  type TronMeasuredExecutionProfile,
  type TronMeasuredExecutionQuotePointProof,
  type TronMeasuredExecutionTarget,
} from "@shared/types/tron-measured-execution";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { toErrorMessage } from "../../lib/error-utils";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../dex-liquidity/source-pagination-state";
import { rotateFromCursor } from "../shared/cursor-rotation";
import {
  buildTronMeasuredQuoteGenerationId,
  loadLatestPublishedTronMeasuredTargets,
  publishTronMeasuredQuoteGeneration,
  type TronMeasuredQuoteOutcome,
} from "./persistence";
import { buildTronMeasuredExecutionProfile } from "./tron-profiles";
import { quoteTronMeasuredTarget } from "./tron-quotes";

const TRON_ADMISSION_SOURCE_KEY = "measured-execution:tron-admission";
// The native consumer reads one published generation, so the current SunSwap
// cohort must fit in one serialized run instead of rotating across generations.
export const TRON_MEASURED_TARGETS_PER_RUN = 21;
export const TRON_MEASURED_RUNTIME_BUDGET_MS = 7 * 60 * 1_000;
export const TRON_MEASURED_REQUEST_HEADROOM_MS = 20_000;

interface TronQuoteState {
  target: TronMeasuredExecutionTarget;
  profile: TronMeasuredExecutionProfile | null;
  failureReason: string | null;
}

export function admitTronMeasuredTargets(
  targets: readonly TronMeasuredExecutionTarget[],
  cursor: string | null,
  limit = TRON_MEASURED_TARGETS_PER_RUN,
): { admitted: Set<string>; nextCursor: string | null } {
  const ranked = [...targets].sort(
    (left, right) => right.retainedTvlUsd - left.retainedTvlUsd || left.targetId.localeCompare(right.targetId),
  );
  const rotated = rotateFromCursor(ranked, cursor, (target) => target.targetId, { startAfterCursor: true }).items;
  const admittedRows = rotated.slice(0, Math.max(0, limit));
  return {
    admitted: new Set(admittedRows.map((target) => target.targetId)),
    nextCursor: admittedRows[admittedRows.length - 1]?.targetId ?? cursor,
  };
}

async function measureTarget(input: {
  target: TronMeasuredExecutionTarget;
  targetGenerationId: string;
  quoteGenerationId: string;
  trongridApiKey?: string | null;
  deadlineMs: number;
  signal?: AbortSignal;
}): Promise<TronMeasuredExecutionProfile> {
  const points: TronMeasuredExecutionQuotePointProof[] = [];
  for (const inputUsd of getDexMeasuredExecutionProbeNotionals(input.target.retainedTvlUsd)) {
    throwIfAborted(input.signal);
    if (Date.now() + TRON_MEASURED_REQUEST_HEADROOM_MS >= input.deadlineMs) throw new Error("producer-deadline");
    const point = await quoteTronMeasuredTarget({
      target: input.target,
      inputUsd,
      trongridApiKey: input.trongridApiKey,
      signal: input.signal,
    });
    points.push(point);
    if (!point.passesCostBound) break;
  }
  const quotedAt = Math.floor(Date.now() / 1_000);
  const profile = buildTronMeasuredExecutionProfile({
    target: input.target,
    targetGenerationId: input.targetGenerationId,
    quoteGenerationId: input.quoteGenerationId,
    quotedAt,
    points,
  });
  const issues = validateTronMeasuredExecutionProfile({
    profile,
    quotedTarget: input.target,
    currentTarget: input.target,
    expectedTargetGenerationId: input.targetGenerationId,
    expectedQuoteGenerationId: input.quoteGenerationId,
    nowSec: quotedAt,
  });
  if (issues.length > 0) throw new Error(`profile-validation:${issues.join(",")}`);
  return profile;
}

export async function syncTronDexMeasuredExecution(
  db: D1Database,
  trongridApiKey?: string | null,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const startedAt = Math.floor(Date.now() / 1_000);
  const deadlineMs = Date.now() + TRON_MEASURED_RUNTIME_BUDGET_MS;
  const deadlineSignal = AbortSignal.timeout(TRON_MEASURED_RUNTIME_BUDGET_MS);
  const producerSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
  const targetGeneration = await loadLatestPublishedTronMeasuredTargets(db, signal);
  if (!targetGeneration || targetGeneration.targets.length === 0) {
    return {
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "tron-target-generation-missing", activation: "shadow" }),
      productivity: { productive: false, reason: "tron-target-generation-missing" },
    };
  }

  const admissionState = await readDexSourcePaginationState(db, TRON_ADMISSION_SOURCE_KEY, "sync-cl-exit-depth");
  const admissionCursor = admissionState.cursor?.trim() || null;
  const { admitted, nextCursor } = admitTronMeasuredTargets(targetGeneration.targets, admissionCursor);
  const quoteGenerationId = buildTronMeasuredQuoteGenerationId(startedAt);
  const states: TronQuoteState[] = targetGeneration.targets.map((target) => ({
    target,
    profile: null,
    failureReason: admitted.has(target.targetId) ? null : "budget-deferred",
  }));

  let completed = 0;
  let rateLimitStopped = false;
  let lastAttemptedTargetId: string | null = null;
  for (const state of states) {
    if (state.failureReason) continue;
    throwIfAborted(signal);
    lastAttemptedTargetId = state.target.targetId;
    try {
      state.profile = await measureTarget({
        target: state.target,
        targetGenerationId: targetGeneration.generationId,
        quoteGenerationId,
        trongridApiKey,
        deadlineMs,
        signal: producerSignal,
      });
    } catch (error) {
      rethrowIfAborted(error, signal);
      state.failureReason = toErrorMessage(error).slice(0, 300);
      if (state.failureReason.startsWith("http-429")) {
        rateLimitStopped = true;
      }
    }
    completed++;
    await reportProgress?.({
      stage: "tron-exact-quotes",
      message: "Capturing shadow SunSwap V2 exact execution quotes",
      itemsDone: completed,
      itemsTotal: admitted.size,
      metadata: { activation: "shadow", targetGenerationId: targetGeneration.generationId },
    });
    if (rateLimitStopped) break;
  }
  if (rateLimitStopped) {
    for (const state of states) {
      if (admitted.has(state.target.targetId) && !state.profile && state.failureReason == null) {
        state.failureReason = "rate-limit-deferred";
      }
    }
  }

  const outcomes: TronMeasuredQuoteOutcome[] = states.map((state) => state.profile
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
      });
  const publishedAt = Math.floor(Date.now() / 1_000);
  const publication = await publishTronMeasuredQuoteGeneration({
    db,
    targetGeneration,
    outcomes,
    quotedAt: publishedAt,
    generationId: quoteGenerationId,
    signal,
  });

  let cursorWriteStatus: "not-needed" | "written" | "missing-table" | "write-failed" = "not-needed";
  const deferredCount = targetGeneration.targets.length - admitted.size;
  const rateLimitDeferredCount = states.filter((state) => state.failureReason === "rate-limit-deferred").length;
  const effectiveNextCursor = rateLimitStopped ? lastAttemptedTargetId : nextCursor;
  if ((deferredCount > 0 || rateLimitStopped) && effectiveNextCursor) {
    const cursorWrite = await writeDexSourcePaginationState({
      db,
      sourceKey: TRON_ADMISSION_SOURCE_KEY,
      cursor: effectiveNextCursor,
      cycleStartedAt: admissionState.cycleStartedAt ?? startedAt,
      nowSec: publishedAt,
      completed: false,
      pagesFetched: admitted.size,
      diagnostics: [`deferred-targets:${deferredCount}`, `target-generation:${targetGeneration.generationId}`],
      job: "sync-cl-exit-depth",
    });
    cursorWriteStatus = cursorWrite.written
      ? "written"
      : cursorWrite.errorClass === "not-configured"
        ? "write-failed"
        : cursorWrite.errorClass;
  }
  const attemptedFailureCount = states.filter(
    (state) =>
      admitted.has(state.target.targetId) &&
      !state.profile &&
      state.failureReason !== "rate-limit-deferred",
  ).length;
  const metadata = {
    activation: "shadow",
    targetGenerationId: targetGeneration.generationId,
    quoteGenerationId: publication.generationId,
    targetCount: targetGeneration.targets.length,
    measuredCount: publication.measuredCount,
    failedCount: publication.failedCount,
    attemptedFailureCount,
    deferredCount,
    rateLimitDeferredCount,
    rateLimitStopped,
    admissionCursor,
    nextAdmissionCursor: effectiveNextCursor,
    cursorWriteStatus,
    failuresByReason: outcomes.reduce<Record<string, number>>((counts, outcome) => {
      if (outcome.status === "failed") {
        const reason = outcome.failureReason ?? "unknown";
        counts[reason] = (counts[reason] ?? 0) + 1;
      }
      return counts;
    }, {}),
  };
  return {
    status: attemptedFailureCount > 0 || cursorWriteStatus === "write-failed" ? "degraded" : "ok",
    itemCount: publication.measuredCount,
    metadata: JSON.stringify(metadata),
    productivity: {
      productive: publication.measuredCount > 0,
      reason: publication.measuredCount > 0 ? "published-tron-measured-execution" : "no-tron-measured-execution",
    },
  };
}
