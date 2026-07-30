import { getDexMeasuredExecutionProbeNotionals } from "@shared/types/measured-execution";
import {
  validateTronMeasuredExecutionProfile,
  type TronMeasuredExecutionProfile,
  type TronMeasuredExecutionQuotePointProof,
  type TronMeasuredExecutionTarget,
} from "@shared/types/tron-measured-execution";
import { throwIfAborted } from "../../lib/abort";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { toErrorMessage } from "../../lib/error-utils";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../dex-liquidity/source-pagination-state";
import { rotateFromCursor } from "../shared/cursor-rotation";
import {
  buildTronMeasuredQuoteGenerationId,
  loadLatestPublishedTronMeasuredTargets,
  publishTronMeasuredQuoteGeneration,
  type PublishedTronMeasuredTargets,
} from "./persistence";
import { buildTronMeasuredExecutionProfile } from "./tron-profiles";
import { quoteTronMeasuredTarget } from "./tron-quotes";
import { getTronMeasuredExecutionAdapterByProfile } from "./tron-registry";
import {
  syncNativeMeasuredExecution,
  type NativeMeasuredExecutionSyncAdapter,
} from "./native-sync";

const TRON_ADMISSION_SOURCE_KEY = "measured-execution:tron-admission";
// The native consumer reads one published generation, so the current SunSwap
// cohort must fit in one serialized run instead of rotating across generations.
export const TRON_MEASURED_TARGETS_PER_RUN = 21;
export const TRON_MEASURED_RUNTIME_BUDGET_MS = 7 * 60 * 1_000;
export const TRON_MEASURED_REQUEST_HEADROOM_MS = 20_000;
const TRON_MEASURED_EXECUTION_DEFAULT_ACTIVATION = "shadow" as const;

function getTronMeasuredExecutionActivation(
  targets: readonly TronMeasuredExecutionTarget[],
): "active" | "shadow" {
  return targets.some(
    (target) => getTronMeasuredExecutionAdapterByProfile(target.adapterProfileId)?.activation === "active",
  )
    ? "active"
    : "shadow";
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
  return syncNativeMeasuredExecution({
    db,
    credential: trongridApiKey,
    signal,
    reportProgress,
    adapter: TRON_NATIVE_SYNC_ADAPTER,
  });
}

export const TRON_NATIVE_SYNC_ADAPTER: NativeMeasuredExecutionSyncAdapter<
  TronMeasuredExecutionTarget,
  TronMeasuredExecutionProfile,
  string,
  Record<string, never>,
  PublishedTronMeasuredTargets
> = {
  runtimeBudgetMs: TRON_MEASURED_RUNTIME_BUDGET_MS,
  missingTargetReason: "tron-target-generation-missing",
  missingTargetActivation: TRON_MEASURED_EXECUTION_DEFAULT_ACTIVATION,
  progressStage: "tron-exact-quotes",
  progressMessage: "Capturing Tron exact execution quotes",
  productivityPublishedReason: "published-tron-measured-execution",
  productivityEmptyReason: "no-tron-measured-execution",
  loadTargetGeneration: loadLatestPublishedTronMeasuredTargets,
  readCursor: (db) =>
    readDexSourcePaginationState(db, TRON_ADMISSION_SOURCE_KEY, "sync-cl-exit-depth"),
  admit: (targets, cursor) => {
    const admission = admitTronMeasuredTargets(targets, cursor);
    return {
      admitted: admission.admitted,
      orderedTargets: targets.filter((target) => admission.admitted.has(target.targetId)),
      nextCursor: admission.nextCursor,
      cursorPagesFetched: admission.admitted.size,
      metadata: {},
    };
  },
  getActivation: getTronMeasuredExecutionActivation,
  buildQuoteGenerationId: buildTronMeasuredQuoteGenerationId,
  measureTarget: ({
    target,
    targetGenerationId,
    quoteGenerationId,
    credential,
    deadlineMs,
    signal,
  }) =>
    measureTarget({
      target,
      targetGenerationId,
      quoteGenerationId,
      trongridApiKey: credential,
      deadlineMs,
      signal,
    }),
  normalizeFailure: (error) => toErrorMessage(error).slice(0, 300),
  shouldStopAfterFailure: (failureReason) => failureReason.startsWith("http-429"),
  stoppedDeferredReason: "rate-limit-deferred",
  publish: publishTronMeasuredQuoteGeneration,
  writeCursor: (input) =>
    writeDexSourcePaginationState({
      db: input.db,
      sourceKey: TRON_ADMISSION_SOURCE_KEY,
      cursor: input.cursor,
      cycleStartedAt: input.cycleStartedAt,
      nowSec: input.nowSec,
      completed: false,
      pagesFetched: input.pagesFetched,
      diagnostics: [
        `deferred-targets:${input.deferredCount}`,
        `target-generation:${input.targetGenerationId}`,
      ],
      job: "sync-cl-exit-depth",
    }),
  buildMetadata: ({ stopped, stoppedDeferredCount }) => ({
    rateLimitDeferredCount: stoppedDeferredCount,
    rateLimitStopped: stopped,
  }),
  shouldDegrade: () => false,
};
