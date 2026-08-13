import { getDexMeasuredExecutionProbeNotionals } from "@shared/types/measured-execution";
import {
  SOLANA_MEASURED_MAX_SLOT_WINDOW,
  validateSolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionQuotePointProof,
  type SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import { throwIfAborted } from "../../lib/abort";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../dex-liquidity/source-pagination-state";
import { rotateFromCursor } from "../shared/cursor-rotation";
import {
  buildSolanaMeasuredQuoteGenerationId,
  loadLatestPublishedSolanaMeasuredTargets,
  publishSolanaMeasuredQuoteGeneration,
  type PublishedSolanaMeasuredTargets,
} from "./persistence";
import {
  getSolanaMeasuredExecutionPriorityTarget,
  SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS,
} from "./solana-registry";
import { buildSolanaMeasuredExecutionProfile } from "./solana-profiles";
import {
  fetchSolanaCurrentSlot,
  normalizeSolanaMeasuredExecutionFailure,
  quoteSolanaMeasuredTarget,
} from "./solana-quotes";
import {
  syncNativeMeasuredExecution,
  type NativeMeasuredExecutionSyncAdapter,
} from "./native-sync";

const SOLANA_ADMISSION_SOURCE_KEY = "measured-execution:solana-admission";
// Preserve thirty cursor-rotated admissions while reserving one additional
// serialized slot for each exact reviewed priority target. This keeps the
// priority evidence inside its one-hour freshness window without reducing
// general inventory coverage or adding request concurrency. Combined with the
// score-facing inventory bound, four half-hour cycles cover the observed
// production cohort inside the universal two-hour freshness horizon.
export const SOLANA_MEASURED_ROTATING_TARGETS_PER_RUN = 30;
const SOLANA_RUNTIME_BUDGET_MS = 7 * 60 * 1_000;

export function admitSolanaMeasuredTargets(
  targets: readonly SolanaMeasuredExecutionTarget[],
  cursor: string | null,
  rotatingLimit = SOLANA_MEASURED_ROTATING_TARGETS_PER_RUN,
): {
  admitted: Set<string>;
  nextCursor: string | null;
  priorityExpectedCount: number;
  priorityObservedCount: number;
  rotatingAdmittedCount: number;
  missingPriorityPolicyIds: string[];
} {
  const priorityByPolicyId = new Map<string, SolanaMeasuredExecutionTarget>();
  const rotatingTargets: SolanaMeasuredExecutionTarget[] = [];
  for (const target of targets) {
    const priority = getSolanaMeasuredExecutionPriorityTarget(target);
    if (priority) {
      priorityByPolicyId.set(priority.policyId, target);
    } else {
      rotatingTargets.push(target);
    }
  }
  const priorityRows = SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS.flatMap((entry) => {
    const target = priorityByPolicyId.get(entry.policyId);
    return target ? [target] : [];
  });
  const grouped = new Map<string, SolanaMeasuredExecutionTarget[]>();
  for (const target of rotatingTargets) {
    const rows = grouped.get(target.stablecoinId) ?? [];
    rows.push(target);
    grouped.set(target.stablecoinId, rows);
  }
  const groups = [...grouped.values()]
    .map((rows) => rows.sort(
      (left, right) => right.retainedTvlUsd - left.retainedTvlUsd || left.targetId.localeCompare(right.targetId),
    ))
    .sort(
      (left, right) =>
        right[0]!.retainedTvlUsd - left[0]!.retainedTvlUsd ||
        left[0]!.stablecoinId.localeCompare(right[0]!.stablecoinId),
    );
  const ranked: SolanaMeasuredExecutionTarget[] = [];
  for (let depth = 0; groups.some((rows) => depth < rows.length); depth++) {
    for (const rows of groups) {
      const target = rows[depth];
      if (target) ranked.push(target);
    }
  }
  const rotated = rotateFromCursor(ranked, cursor, (target) => target.targetId, {
    startAfterCursor: true,
  }).items;
  const rotatingRows = rotated.slice(0, Math.max(0, rotatingLimit));
  return {
    admitted: new Set([...priorityRows, ...rotatingRows].map((target) => target.targetId)),
    nextCursor: rotatingRows[rotatingRows.length - 1]?.targetId ?? cursor,
    priorityExpectedCount: SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS.length,
    priorityObservedCount: priorityRows.length,
    rotatingAdmittedCount: rotatingRows.length,
    missingPriorityPolicyIds: SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS
      .filter((entry) => !priorityByPolicyId.has(entry.policyId))
      .map((entry) => entry.policyId),
  };
}

export function orderAdmittedSolanaMeasuredTargets(
  targets: readonly SolanaMeasuredExecutionTarget[],
  admitted: ReadonlySet<string>,
): SolanaMeasuredExecutionTarget[] {
  return targets
    .flatMap((target, index) =>
      admitted.has(target.targetId)
        ? [{ target, index, priority: getSolanaMeasuredExecutionPriorityTarget(target) !== null }]
        : [],
    )
    .sort((left, right) => Number(right.priority) - Number(left.priority) || left.index - right.index)
    .map(({ target }) => target);
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
  return syncNativeMeasuredExecution({
    db,
    credential: jupiterApiKey,
    signal,
    reportProgress,
    adapter: SOLANA_NATIVE_SYNC_ADAPTER,
  });
}

interface SolanaAdmissionMetadata {
  priorityExpectedCount: number;
  priorityObservedCount: number;
  rotatingAdmittedCount: number;
  missingPriorityPolicyIds: string[];
}

export const SOLANA_NATIVE_SYNC_ADAPTER: NativeMeasuredExecutionSyncAdapter<
  SolanaMeasuredExecutionTarget,
  SolanaMeasuredExecutionProfile,
  string,
  SolanaAdmissionMetadata,
  PublishedSolanaMeasuredTargets
> = {
  runtimeBudgetMs: SOLANA_RUNTIME_BUDGET_MS,
  missingTargetReason: "solana-target-generation-missing",
  missingTargetActivation: "target-ratified",
  progressStage: "solana-exact-quotes",
  progressMessage: "Capturing Solana exact execution quotes",
  productivityPublishedReason: "published-solana-measured-execution",
  productivityEmptyReason: "no-solana-measured-execution",
  loadTargetGeneration: loadLatestPublishedSolanaMeasuredTargets,
  readCursor: (db) =>
    readDexSourcePaginationState(db, SOLANA_ADMISSION_SOURCE_KEY, "sync-cl-exit-depth"),
  admit: (targets, cursor) => {
    const admission = admitSolanaMeasuredTargets(targets, cursor);
    return {
      admitted: admission.admitted,
      orderedTargets: orderAdmittedSolanaMeasuredTargets(targets, admission.admitted),
      nextCursor: admission.nextCursor,
      cursorPagesFetched: admission.rotatingAdmittedCount,
      metadata: {
        priorityExpectedCount: admission.priorityExpectedCount,
        priorityObservedCount: admission.priorityObservedCount,
        rotatingAdmittedCount: admission.rotatingAdmittedCount,
        missingPriorityPolicyIds: admission.missingPriorityPolicyIds,
      },
    };
  },
  getActivation: () => "target-ratified",
  buildQuoteGenerationId: buildSolanaMeasuredQuoteGenerationId,
  measureTarget: ({ target, targetGenerationId, quoteGenerationId, credential, signal }) =>
    measureTarget({
      target,
      targetGenerationId,
      quoteGenerationId,
      jupiterApiKey: credential,
      signal,
    }),
  normalizeFailure: normalizeSolanaMeasuredExecutionFailure,
  publish: publishSolanaMeasuredQuoteGeneration,
  writeCursor: (input) =>
    writeDexSourcePaginationState({
      db: input.db,
      sourceKey: SOLANA_ADMISSION_SOURCE_KEY,
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
  buildMetadata: ({ admission }) => ({
    priorityExpectedCount: admission.metadata.priorityExpectedCount,
    priorityObservedCount: admission.metadata.priorityObservedCount,
    priorityAdmittedCount: admission.metadata.priorityObservedCount,
    rotatingAdmittedCount: admission.metadata.rotatingAdmittedCount,
    missingPriorityPolicyIds: admission.metadata.missingPriorityPolicyIds,
  }),
  shouldDegrade: ({ admission }) => admission.metadata.missingPriorityPolicyIds.length > 0,
};
