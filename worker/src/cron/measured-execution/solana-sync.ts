import { getDexMeasuredExecutionProbeNotionals } from "@shared/types/measured-execution";
import {
  SOLANA_MEASURED_MAX_SLOT_WINDOW,
  validateSolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionQuotePointProof,
  type SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { toErrorMessage } from "../../lib/error-utils";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../dex-liquidity/source-pagination-state";
import { rotateFromCursor } from "../shared/cursor-rotation";
import {
  buildSolanaMeasuredQuoteGenerationId,
  loadLatestPublishedSolanaMeasuredTargets,
  publishSolanaMeasuredQuoteGeneration,
  type SolanaMeasuredQuoteOutcome,
} from "./persistence";
import { buildSolanaMeasuredExecutionProfile } from "./solana-profiles";
import { fetchSolanaCurrentSlot, quoteSolanaMeasuredTarget } from "./solana-quotes";

const SOLANA_ADMISSION_SOURCE_KEY = "measured-execution:solana-admission";
// Twelve admissions per half-hour cover the current inventory almost three
// times during a 72-hour evidence window without adding request concurrency.
const MAX_TARGETS_PER_RUN = 12;
const SOLANA_RUNTIME_BUDGET_MS = 7 * 60 * 1_000;

interface SolanaQuoteState {
  target: SolanaMeasuredExecutionTarget;
  profile: SolanaMeasuredExecutionProfile | null;
  failureReason: string | null;
}

export function admitSolanaMeasuredTargets(
  targets: readonly SolanaMeasuredExecutionTarget[],
  cursor: string | null,
  limit = MAX_TARGETS_PER_RUN,
): { admitted: Set<string>; nextCursor: string | null } {
  const ranked = [...targets].sort(
    (left, right) => right.retainedTvlUsd - left.retainedTvlUsd || left.targetId.localeCompare(right.targetId),
  );
  const rotated = rotateFromCursor(ranked, cursor, (target) => target.targetId, {
    startAfterCursor: true,
  }).items;
  const admittedRows = rotated.slice(0, Math.max(0, limit));
  return {
    admitted: new Set(admittedRows.map((target) => target.targetId)),
    nextCursor: admittedRows[admittedRows.length - 1]?.targetId ?? cursor,
  };
}

async function measureTarget(input: {
  target: SolanaMeasuredExecutionTarget;
  targetGenerationId: string;
  quoteGenerationId: string;
  jupiterApiKey?: string | null;
  signal?: AbortSignal;
}): Promise<SolanaMeasuredExecutionProfile> {
  const slotBefore = await fetchSolanaCurrentSlot(input.signal);
  if (slotBefore == null) throw new Error("slot-before-unavailable");
  const points: SolanaMeasuredExecutionQuotePointProof[] = [];
  for (const inputUsd of getDexMeasuredExecutionProbeNotionals(input.target.retainedTvlUsd)) {
    throwIfAborted(input.signal);
    const point = await quoteSolanaMeasuredTarget({
      target: input.target,
      inputUsd,
      jupiterApiKey: input.jupiterApiKey,
      signal: input.signal,
    });
    points.push(point);
    if (!point.passesCostBound) break;
  }
  const slotAfter = await fetchSolanaCurrentSlot(input.signal);
  if (slotAfter == null) throw new Error("slot-after-unavailable");
  if (slotAfter < slotBefore || slotAfter - slotBefore > SOLANA_MEASURED_MAX_SLOT_WINDOW) {
    throw new Error("slot-window-invalid");
  }
  const quotedAt = Math.floor(Date.now() / 1_000);
  const profile = buildSolanaMeasuredExecutionProfile({
    target: input.target,
    targetGenerationId: input.targetGenerationId,
    quoteGenerationId: input.quoteGenerationId,
    quotedAt,
    slotBefore,
    slotAfter,
    points,
  });
  const issues = validateSolanaMeasuredExecutionProfile({
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

export async function syncSolanaDexMeasuredExecution(
  db: D1Database,
  jupiterApiKey?: string | null,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const startedAt = Math.floor(Date.now() / 1_000);
  const deadlineSignal = AbortSignal.timeout(SOLANA_RUNTIME_BUDGET_MS);
  const producerSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
  const targetGeneration = await loadLatestPublishedSolanaMeasuredTargets(db, signal);
  if (!targetGeneration || targetGeneration.targets.length === 0) {
    return {
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "solana-target-generation-missing", activation: "shadow" }),
      productivity: { productive: false, reason: "solana-target-generation-missing" },
    };
  }

  const admissionState = await readDexSourcePaginationState(db, SOLANA_ADMISSION_SOURCE_KEY, "sync-cl-exit-depth");
  const admissionCursor = admissionState.cursor?.trim() || null;
  const { admitted, nextCursor } = admitSolanaMeasuredTargets(targetGeneration.targets, admissionCursor);
  const quoteGenerationId = buildSolanaMeasuredQuoteGenerationId(startedAt);
  const states: SolanaQuoteState[] = targetGeneration.targets.map((target) => ({
    target,
    profile: null,
    failureReason: admitted.has(target.targetId) ? null : "budget-deferred",
  }));

  let completed = 0;
  for (const state of states) {
    if (state.failureReason) continue;
    throwIfAborted(signal);
    try {
      state.profile = await measureTarget({
        target: state.target,
        targetGenerationId: targetGeneration.generationId,
        quoteGenerationId,
        jupiterApiKey,
        signal: producerSignal,
      });
    } catch (error) {
      rethrowIfAborted(error, signal);
      state.failureReason = toErrorMessage(error).slice(0, 300);
    }
    completed++;
    await reportProgress?.({
      stage: "solana-exact-quotes",
      message: "Capturing shadow Solana exact execution quotes",
      itemsDone: completed,
      itemsTotal: admitted.size,
      metadata: { activation: "shadow", targetGenerationId: targetGeneration.generationId },
    });
  }

  const outcomes: SolanaMeasuredQuoteOutcome[] = states.map((state) =>
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
  const publication = await publishSolanaMeasuredQuoteGeneration({
    db,
    targetGeneration,
    outcomes,
    quotedAt: publishedAt,
    generationId: quoteGenerationId,
    signal,
  });

  let cursorWriteStatus: "not-needed" | "written" | "missing-table" | "write-failed" = "not-needed";
  const deferredCount = targetGeneration.targets.length - admitted.size;
  if (deferredCount > 0 && nextCursor) {
    const cursorWrite = await writeDexSourcePaginationState({
      db,
      sourceKey: SOLANA_ADMISSION_SOURCE_KEY,
      cursor: nextCursor,
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
    (state) => admitted.has(state.target.targetId) && !state.profile,
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
    admissionCursor,
    nextAdmissionCursor: nextCursor,
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
      reason: publication.measuredCount > 0 ? "published-solana-measured-execution" : "no-solana-measured-execution",
    },
  };
}
