import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import {
  V9_CONSUMER_SCORE_THRESHOLD_REGISTRY,
  V9_SHADOW_DAILY_START_OFFSET_SEC,
  V9_SHADOW_MAX_START_DELAY_SEC,
} from "@shared/lib/safety-score-v9/operational-gate";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { ReportCard } from "@shared/types/report-cards";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { V9_RELEASE_COVERAGE_FLOORS } from "@shared/types/safety-score-v9-coverage";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";
import type { ReportCardPublicationCompleteness } from "./report-card-publication";
import {
  buildSafetyScoreV9CandidateFromNormalizedInput,
  type SafetyScoreV9CandidatePipelineResult,
} from "./safety-score-v9-candidate";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "./safety-score-v9-extension";
import {
  loadSafetyScoreV9MovementReviewCarries,
  loadSafetyScoreV9MovementReviewDispositions,
} from "./safety-score-v9-movement-reviews";
import {
  assessSafetyScoreV9ShadowReleaseCoverage,
  loadSafetyScoreV9SealedReleaseCandidateId,
} from "./safety-score-v9-release-coverage";
import {
  assessSafetyScoreV9ShadowQualification,
  buildSafetyScoreV9DiffReport,
  buildSafetyScoreV9ShadowDailyFailure,
  buildSafetyScoreV9ShadowDailySuccess,
  buildSafetyScoreV9ShadowEnvelope,
  projectSafetyScoreV9ShadowEnvelopeCore,
  rebuildSafetyScoreV9ShadowEnvelope,
  SAFETY_SCORE_V9_REQUIRED_SHADOW_COVERAGE_FLOOR_IDS,
  SAFETY_SCORE_V9_SHADOW_MINIMUM_QUALIFYING_DAYS,
  safetyScoreV9ShadowLastSuccessfulAttemptAtSec,
  safetyScoreV9UtcDay,
  type SafetyScoreV8ComparableSnapshot,
  type SafetyScoreV9CoverageFloor,
  type SafetyScoreV9DownstreamThreshold,
  type SafetyScoreV9ShadowArchiveSelectionReason,
  type SafetyScoreV9ShadowDaily,
  type SafetyScoreV9ShadowEnvelope,
  type SafetyScoreV9ShadowFailureStage,
  type SafetyScoreV9ShadowSelectedRun,
} from "./safety-score-v9-shadow";
import {
  buildSafetyScoreV9LocalArtifactBundle,
  getSafetyScoreV9LocalArtifactBundleArtifacts,
  getSafetyScoreV9LocalArtifactBundleReferences,
  loadSafetyScoreV9ShadowHistory,
  persistSafetyScoreV9ShadowState,
  type SafetyScoreV9LocalArtifactBundle,
} from "./safety-score-v9-store";

export const SAFETY_SCORE_V9_SHADOW_ATTEMPT_PREFIX = "safety-score-v9-shadow";

/**
 * Minimum age of the day's latest success before the quarter-hourly caller
 * re-runs the shadow. Three hours yields up to eight refreshes per UTC day —
 * frequent enough for same-day candidate iteration while keeping compute and
 * D1 writes bounded. The daily summary remains one row per day: the EARLIEST
 * in-window success (00:30-01:30 UTC, per the scheduled-start-latency floor)
 * stays selected all day, and later refreshes only advance daily metadata.
 */
export const SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC = 3 * 60 * 60;
export const SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC = V9_SHADOW_DAILY_START_OFFSET_SEC;
export const SAFETY_SCORE_V9_SHADOW_MAX_START_DELAY_SEC = V9_SHADOW_MAX_START_DELAY_SEC;
export const SAFETY_SCORE_V9_SHADOW_TIMEOUT_MS = 2 * 60_000;

export interface RunSafetyScoreV9ShadowInput {
  db: D1Database;
  fixedInput: unknown;
  v8Cards: readonly ReportCard[];
  v8Publication: ReportCardPublicationCompleteness;
  v8MethodologyVersion: string;
  signal?: AbortSignal;
  nowSec?: number;
  /**
   * Sealed release-candidate label (`v9-rc-N`) for an explicitly sealed run.
   * It both seals the candidate id and keys the ratified cohort lookup. Left
   * unset, the run stays content-addressed and the cohort key comes from the
   * owner's D1 sealed release-candidate designation.
   */
  releaseCandidateId?: string;
  archiveSelectionReasons?: readonly Exclude<SafetyScoreV9ShadowArchiveSelectionReason, "first" | "final">[];
}

export type SafetyScoreV9ShadowRunResult =
  | {
      status: "published";
      attemptId: string;
      utcDay: string;
      publicationGenerationId: string;
      candidateId: string;
      qualifying: boolean;
      qualificationBlockers: string[];
      pendingReviewCount: number;
      archiveSelectionReasons: SafetyScoreV9ShadowArchiveSelectionReason[];
    }
  | {
      status: "skipped";
      attemptId: string;
      utcDay: string;
      reason: "successful-run-already-selected";
      qualifying: boolean;
    }
  | {
      status: "skipped";
      attemptId: string;
      utcDay: string;
      reason: "waiting-for-score-bearing-producers";
      scheduledForSec: number;
    }
  | {
      status: "failed";
      attemptId: string;
      utcDay: string;
      stage: SafetyScoreV9ShadowFailureStage;
      code: string;
      message: string;
    };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function fallbackNowSec(): number {
  return Math.max(0, Math.floor(Date.now() / 1_000));
}

function nowSecAtLeast(minimum: number, override?: number): number {
  const value = override ?? fallbackNowSec();
  if (!Number.isInteger(value) || value < 0) throw new Error("Safety Score v9 shadow clock must be epoch seconds");
  return Math.max(minimum, value);
}

function scheduledForUtcDay(clockSec: number): number {
  const day = safetyScoreV9UtcDay(clockSec);
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1_000) + SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC;
}

function adjacentUtcDay(utcDay: string, offsetDays: number): string {
  const timestamp = Date.parse(`${utcDay}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid Safety Score v9 UTC day: ${utcDay}`);
  return new Date(timestamp + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function sameFrozenShadowIdentity(
  left: SafetyScoreV9ShadowSelectedRun,
  right: SafetyScoreV9ShadowSelectedRun,
): boolean {
  return (
    left.identity.candidateId === right.identity.candidateId &&
    left.identity.policyId === right.identity.policyId &&
    left.identity.policyVersion === right.identity.policyVersion &&
    left.identity.policyDigest === right.identity.policyDigest &&
    left.identity.evaluationBuildDigest === right.identity.evaluationBuildDigest &&
    left.identity.compilerFactSchemaDigest === right.identity.compilerFactSchemaDigest &&
    left.identity.producerCapabilityDigest === right.identity.producerCapabilityDigest &&
    left.identity.releaseCoveragePolicyDigest === right.identity.releaseCoveragePolicyDigest &&
    left.identity.consumerThresholdRegistryDigest === right.identity.consumerThresholdRegistryDigest
  );
}

/** Selects the bounded replay set without creating an online release authority. */
export function selectSafetyScoreV9ShadowArchiveReasons(input: {
  history: readonly SafetyScoreV9ShadowDaily[];
  current: SafetyScoreV9ShadowDaily;
  requested?: readonly Exclude<SafetyScoreV9ShadowArchiveSelectionReason, "first" | "final">[];
}): SafetyScoreV9ShadowArchiveSelectionReason[] {
  const currentRun = input.current.selectedRun;
  if (currentRun === null) throw new Error("Safety Score v9 archive selection requires a successful current run");
  const historyByDay = new Map(input.history.map((day) => [day.utcDay, day]));
  const previousRun = historyByDay.get(adjacentUtcDay(input.current.utcDay, -1))?.selectedRun ?? null;
  const startsQualifyingWindow =
    currentRun.qualification.qualifies &&
    (previousRun === null ||
      !previousRun.qualification.qualifies ||
      !sameFrozenShadowIdentity(previousRun, currentRun));

  let qualifyingStreakDays = currentRun.qualification.qualifies ? 1 : 0;
  let currentStreakHasFinal = false;
  if (currentRun.qualification.qualifies) {
    for (let offset = -1; ; offset -= 1) {
      const run = historyByDay.get(adjacentUtcDay(input.current.utcDay, offset))?.selectedRun ?? null;
      if (run === null || !run.qualification.qualifies || !sameFrozenShadowIdentity(run, currentRun)) break;
      qualifyingStreakDays += 1;
      if (run.archiveSelectionReasons.includes("final")) currentStreakHasFinal = true;
    }
  }
  const completesQualifyingWindow =
    currentRun.qualification.qualifies &&
    qualifyingStreakDays >= SAFETY_SCORE_V9_SHADOW_MINIMUM_QUALIFYING_DAYS &&
    !currentStreakHasFinal;

  const requested = input.requested ?? [];
  if (requested.some((reason) => reason !== "anomaly")) {
    throw new Error("Only anomaly Safety Score v9 replay evidence may be selected explicitly");
  }
  if (requested.includes("anomaly") && currentRun.qualification.qualifies) {
    throw new Error("Anomaly Safety Score v9 replay evidence must be selected from a non-qualifying run");
  }
  return sortedUnique<SafetyScoreV9ShadowArchiveSelectionReason>([
    ...requested,
    ...(startsQualifyingWindow ? (["first"] as const) : []),
    ...(completesQualifyingWindow ? (["final"] as const) : []),
  ]);
}

function attemptId(utcDay: string, previous: SafetyScoreV9ShadowDaily | null): string {
  const sequence = (previous?.attemptCounts.successful ?? 0) + (previous?.attemptCounts.failed ?? 0) + 1;
  return `${SAFETY_SCORE_V9_SHADOW_ATTEMPT_PREFIX}:${utcDay}:${sequence}`;
}

function v8ReasonCodes(card: ReportCard): string[] {
  const reasons: string[] = [];
  if (card.overallScore === null) reasons.push("v8-not-rated");
  for (const [dimension, value] of Object.entries(card.dimensions)) {
    if (value.score === null) reasons.push(`v8-dimension-not-rated:${dimension}`);
  }
  if ((card.rawInputs.activeDepegBps ?? 0) > 0) reasons.push("v8-active-depeg");
  if (card.overallCapped) reasons.push("v8-variant-parent-cap");
  return sortedUnique(reasons);
}

function buildV8ComparableSnapshot(args: {
  fixedInput: ReportCardsFixedInput;
  cards: readonly ReportCard[];
  publication: ReportCardPublicationCompleteness;
  methodologyVersion: string;
}): SafetyScoreV8ComparableSnapshot {
  return {
    model: "v8",
    publicationGenerationId: args.publication.generationId,
    baseInputGenerationId: args.fixedInput.baseInputGenerationId,
    methodologyVersion: args.methodologyVersion,
    evaluationBuildDigest: SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST,
    cards: [...args.cards]
      .sort((left, right) => compareText(left.id, right.id))
      .map((card) => ({
        id: card.id,
        score: card.overallScore,
        grade: card.overallGrade,
        bindingCap:
          card.overallCapped && card.overallScore !== null
            ? {
                kind: "variant-parent",
                limit: card.overallScore,
                source: card.rawInputs.variantParentId ?? null,
              }
            : null,
        reasonCodes: v8ReasonCodes(card),
      })),
  };
}

function releaseCoverageFloors(
  observedCount: number,
  expectedCount: number,
  rateableCount: number,
  scheduledForSec: number,
  startedAtSec: number,
  ratifiedReleaseCoverageFloor: SafetyScoreV9CoverageFloor,
): SafetyScoreV9CoverageFloor[] {
  const exactCount = observedCount === expectedCount;
  const startDelaySec = Math.max(0, startedAtSec - scheduledForSec);
  const floors = [
    {
      id: "active-result-count",
      status: exactCount ? "pass" : "fail",
      observed: observedCount,
      required: `= ${expectedCount}`,
      detail: exactCount
        ? "The V9 candidate contains one result for every active v8 publication asset"
        : "The V9 candidate result count does not match the active v8 publication",
    },
    {
      id: "minimum-rateable-assets",
      status: rateableCount >= V9_RELEASE_COVERAGE_FLOORS.minimumRateableAssets ? "pass" : "fail",
      observed: rateableCount,
      required: `>= ${V9_RELEASE_COVERAGE_FLOORS.minimumRateableAssets}`,
      detail:
        rateableCount >= V9_RELEASE_COVERAGE_FLOORS.minimumRateableAssets
          ? "The V9 candidate meets the ratified active-asset rateability floor"
          : "The V9 candidate is below the ratified active-asset rateability floor",
    },
    ratifiedReleaseCoverageFloor,
    {
      id: "scheduled-start-latency",
      status: startDelaySec <= SAFETY_SCORE_V9_SHADOW_MAX_START_DELAY_SEC ? "pass" : "fail",
      observed: startDelaySec,
      required: `<= ${SAFETY_SCORE_V9_SHADOW_MAX_START_DELAY_SEC} seconds after the scheduled daily selection point`,
      detail:
        startDelaySec <= SAFETY_SCORE_V9_SHADOW_MAX_START_DELAY_SEC
          ? "The daily shadow attempt began inside the preregistered start window"
          : "The daily shadow attempt began too late to represent a complete prospective UTC day",
    },
  ].sort((left, right) => compareText(left.id, right.id)) as SafetyScoreV9CoverageFloor[];
  if (
    stableJsonStringifyV1(floors.map((floor) => floor.id)) !==
    stableJsonStringifyV1(SAFETY_SCORE_V9_REQUIRED_SHADOW_COVERAGE_FLOOR_IDS)
  ) {
    throw new Error("Safety Score v9 shadow coverage-floor registry is incomplete");
  }
  return floors;
}

function downstreamThresholds(): SafetyScoreV9DownstreamThreshold[] {
  const gradeThresholds = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds
    .filter((threshold) => threshold.minScore > 0)
    .map((threshold: { grade: Exclude<V9Grade, "NR">; minScore: number }) => ({
      id: `grade-minimum:${threshold.grade}`,
      label: `${threshold.grade} minimum`,
      score: threshold.minScore,
      comparison: "at-least" as const,
    }));
  return [...gradeThresholds, ...V9_CONSUMER_SCORE_THRESHOLD_REGISTRY].sort((left, right) =>
    compareText(left.id, right.id),
  );
}

function supplyProjection(pipeline: SafetyScoreV9CandidatePipelineResult): {
  supplyUsdById: Record<string, number>;
  topCutoffIds: Set<string>;
} {
  const supplies = pipeline.compiledFacts.assets
    .map((asset) => ({ id: asset.assetId, supplyUsd: asset.supply.circulatingUsd ?? 0 }))
    .sort((left, right) => right.supplyUsd - left.supplyUsd || compareText(left.id, right.id));
  const cutoff = supplies[Math.min(24, supplies.length - 1)]?.supplyUsd ?? Number.POSITIVE_INFINITY;
  return {
    supplyUsdById: Object.fromEntries(supplies.map((entry) => [entry.id, entry.supplyUsd])),
    topCutoffIds: new Set(supplies.filter((entry) => entry.supplyUsd >= cutoff).map((entry) => entry.id)),
  };
}

function safeFailure(error: unknown, stage: SafetyScoreV9ShadowFailureStage): { code: string; message: string } {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    code: `safety-score-v9-shadow-${stage}-${name}`.slice(0, 160),
    message: (rawMessage.trim() || "Safety Score v9 shadow attempt failed").slice(0, 500),
  };
}

function combinedShadowSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SAFETY_SCORE_V9_SHADOW_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function persistFailure(args: {
  db: D1Database;
  utcDay: string;
  atSec: number;
  previous: SafetyScoreV9ShadowDaily | null;
  stage: SafetyScoreV9ShadowFailureStage;
  failure: { code: string; message: string };
  signal?: AbortSignal;
}): Promise<void> {
  const daily = buildSafetyScoreV9ShadowDailyFailure({
    utcDay: args.utcDay,
    updatedAtSec: args.atSec,
    previous: args.previous,
    failure: { atSec: args.atSec, stage: args.stage, ...args.failure },
  });
  await persistSafetyScoreV9ShadowState(args.db, { daily, signal: args.signal });
}

/**
 * Runs V9 only after the authoritative V8 commit. The boundary always returns
 * a shadow result: calculation, timeout, and persistence failures never unwind
 * the completed V8 publication.
 */
export async function runSafetyScoreV9ShadowAfterV8Publication(
  input: RunSafetyScoreV9ShadowInput,
): Promise<SafetyScoreV9ShadowRunResult> {
  const fallbackAtSec = fallbackNowSec();
  let utcDay = safetyScoreV9UtcDay(fallbackAtSec);
  let currentAttemptId = `${SAFETY_SCORE_V9_SHADOW_ATTEMPT_PREFIX}:${utcDay}:1`;
  let previous: SafetyScoreV9ShadowDaily | null = null;
  let startedAtSec = fallbackAtSec;
  let stage: SafetyScoreV9ShadowFailureStage = "base-input";
  const shadowSignal = combinedShadowSignal(input.signal);

  try {
    if (input.nowSec !== undefined && (!Number.isInteger(input.nowSec) || input.nowSec < 0)) {
      throw new Error("Safety Score v9 shadow clock must be epoch seconds");
    }
    const fixedInput = normalizeFixedInput(input.fixedInput);
    const scheduledForSec = scheduledForUtcDay(fixedInput.clockSec);
    utcDay = safetyScoreV9UtcDay(scheduledForSec);

    stage = "scheduler";
    const history = await loadSafetyScoreV9ShadowHistory(input.db, {
      toUtcDay: utcDay,
      limit: 400,
      signal: shadowSignal,
    });
    previous = history.find((daily) => daily.utcDay === utcDay) ?? null;
    currentAttemptId = attemptId(utcDay, previous);
    // A selected success no longer pins the whole UTC day: the shadow
    // refreshes on a bounded intra-day cadence so candidate iteration is
    // visible in the retained latest rows the same day. The daily summary
    // stays one row; once an in-window run is selected it stays selected, so
    // the throttle must measure from the LATEST success (derived from the
    // daily row), not from the pinned selection. A run younger than the
    // refresh interval still skips to bound compute and writes.
    const lastSuccessfulAtSec =
      previous === null ? null : safetyScoreV9ShadowLastSuccessfulAttemptAtSec(previous);
    if (
      lastSuccessfulAtSec !== null &&
      fixedInput.clockSec - lastSuccessfulAtSec < SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC
    ) {
      return {
        status: "skipped",
        attemptId: currentAttemptId,
        utcDay,
        reason: "successful-run-already-selected",
        qualifying: previous?.selectedRun?.qualification.qualifies ?? false,
      };
    }
    if (fixedInput.clockSec < scheduledForSec) {
      return {
        status: "skipped",
        attemptId: currentAttemptId,
        utcDay,
        reason: "waiting-for-score-bearing-producers",
        scheduledForSec,
      };
    }

    startedAtSec = nowSecAtLeast(fixedInput.clockSec, input.nowSec);
    stage = "v9-enrichment";
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput);
    stage = "compile";
    const pipeline = buildSafetyScoreV9CandidateFromNormalizedInput({
      fixedInput,
      extension,
      publishedAtSec: fixedInput.clockSec,
      releaseCandidateId: input.releaseCandidateId,
    });
    const publicationGenerationId = pipeline.candidate.publicationGenerationId;
    const candidateId = pipeline.candidate.candidateId;

    const completedAtSec = nowSecAtLeast(startedAtSec, input.nowSec);
    const expectedActiveIds = [...fixedInput.activeAssetIds].sort(compareText);
    stage = "serialize";
    // The sealed `v9-rc-N` label keys the ratified cohort and is distinct from
    // the content-addressed `candidateId` above. An explicitly sealed run
    // carries its own label; otherwise the owner's D1 designation supplies it,
    // and an absent designation leaves the floor failing closed.
    const sealedReleaseCandidateId =
      input.releaseCandidateId ?? (await loadSafetyScoreV9SealedReleaseCandidateId(input.db, shadowSignal));
    const releaseCoverage = await assessSafetyScoreV9ShadowReleaseCoverage({
      db: input.db,
      releaseCandidateId: sealedReleaseCandidateId,
      candidateId,
      candidatePolicyDigest: pipeline.candidate.policy.semanticDigest,
      candidateEvaluationBuildDigest: pipeline.candidate.evaluationBuildDigest,
      candidateFactSetDigest: pipeline.candidate.factSetDigest,
      candidateResultDigest: pipeline.candidate.resultDigest,
      compiledFacts: pipeline.compiledFacts,
      evaluatedSet: pipeline.evaluatedSet,
      producerCapabilityDigest: pipeline.producerCapabilityDigest,
      signal: shadowSignal,
    });
    const floors = releaseCoverageFloors(
      pipeline.candidate.cards.length,
      expectedActiveIds.length,
      pipeline.candidate.completeness.ratedCount,
      scheduledForSec,
      startedAtSec,
      releaseCoverage.floor,
    );
    const baseEnvelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: pipeline.candidate,
      expectedActiveIds,
      compilerFactSchemaDigest: pipeline.compilerFactSchemaDigest,
      producerCapabilityDigest: pipeline.producerCapabilityDigest,
      coverageFloors: floors,
      unresolvedReleaseBlockers: releaseCoverage.unresolvedReleaseBlockers,
    });
    const supply = supplyProjection(pipeline);
    const v8 = buildV8ComparableSnapshot({
      fixedInput,
      cards: input.v8Cards,
      publication: input.v8Publication,
      methodologyVersion: input.v8MethodologyVersion,
    });

    const pendingDiff = buildSafetyScoreV9DiffReport({
      generatedAtSec: completedAtSec,
      expectedActiveIds,
      v8,
      v9: baseEnvelope,
      topCutoffIds: supply.topCutoffIds,
      downstreamThresholds: downstreamThresholds(),
      supplyUsdById: supply.supplyUsdById,
    });
    const reviewDispositionsByKey = await loadSafetyScoreV9MovementReviewDispositions(
      input.db,
      pendingDiff.cards.flatMap((card) => (card.review.key === null ? [] : [card.review.key])),
      shadowSignal,
    );
    const reviewCarriesByClassKey = await loadSafetyScoreV9MovementReviewCarries(
      input.db,
      pendingDiff.cards.flatMap((card) => (card.review.classKey === null ? [] : [card.review.classKey])),
      shadowSignal,
    );
    const reviewedDiff = buildSafetyScoreV9DiffReport({
      generatedAtSec: completedAtSec,
      expectedActiveIds,
      v8,
      v9: baseEnvelope,
      topCutoffIds: supply.topCutoffIds,
      downstreamThresholds: downstreamThresholds(),
      supplyUsdById: supply.supplyUsdById,
      reviewDispositionsByKey,
      reviewCarriesByClassKey,
    });
    const unresolvedCriticalMovementIds = reviewedDiff.cards
      .filter(
        (card) =>
          card.review.status === "pending" ||
          card.review.disposition === "producer-data-gap" ||
          card.review.disposition === "defect",
      )
      .map((card) => card.id);
    let envelope: SafetyScoreV9ShadowEnvelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: pipeline.candidate,
      expectedActiveIds,
      compilerFactSchemaDigest: pipeline.compilerFactSchemaDigest,
      producerCapabilityDigest: pipeline.producerCapabilityDigest,
      coverageFloors: floors,
      unresolvedReleaseBlockers: releaseCoverage.unresolvedReleaseBlockers,
      unresolvedCriticalMovementIds,
    });
    let diff = buildSafetyScoreV9DiffReport({
      generatedAtSec: completedAtSec,
      expectedActiveIds,
      v8,
      v9: envelope,
      topCutoffIds: supply.topCutoffIds,
      downstreamThresholds: downstreamThresholds(),
      supplyUsdById: supply.supplyUsdById,
      reviewDispositionsByKey,
    });
    const qualification = assessSafetyScoreV9ShadowQualification(envelope);
    let daily = buildSafetyScoreV9ShadowDailySuccess({
      utcDay,
      selectedAtSec: completedAtSec,
      updatedAtSec: completedAtSec,
      previous,
      envelope,
      diff,
    });
    // Start-latency pin: when the day already has an in-window selected run,
    // the daily builder keeps it and this refresh becomes a metadata-only
    // update — the attempt is counted, but the retained latest envelope/diff
    // rows and any archive evidence stay bound to the pinned in-window run.
    const selectionPinned =
      previous?.selectedRun !== null &&
      previous?.selectedRun !== undefined &&
      stableJsonStringifyV1(daily.selectedRun) === stableJsonStringifyV1(previous.selectedRun);
    if (selectionPinned) {
      if (input.archiveSelectionReasons !== undefined && input.archiveSelectionReasons.length > 0) {
        throw new Error(
          "Safety Score v9 archive selection requires the attempt to become the day's selected run; the day is pinned to its earliest in-window run",
        );
      }
      stage = "shadow-write";
      await persistSafetyScoreV9ShadowState(input.db, { daily, signal: shadowSignal });
      return {
        status: "published",
        attemptId: currentAttemptId,
        utcDay,
        publicationGenerationId,
        candidateId,
        qualifying: daily.selectedRun!.qualification.qualifies,
        qualificationBlockers: [...daily.selectedRun!.qualification.blockers],
        pendingReviewCount: diff.summary.pendingReviewCount,
        archiveSelectionReasons: [],
      };
    }
    const archiveSelectionReasons = selectSafetyScoreV9ShadowArchiveReasons({
      history,
      current: daily,
      requested: input.archiveSelectionReasons,
    });

    let localArtifactBundle: SafetyScoreV9LocalArtifactBundle | undefined;
    if (archiveSelectionReasons.length > 0) {
      stage = "artifact-retention";
      const envelopeCore = projectSafetyScoreV9ShadowEnvelopeCore(envelope);
      localArtifactBundle = await buildSafetyScoreV9LocalArtifactBundle(
        [
          {
            kind: "base-input",
            identity: pipeline.candidate.baseInputGenerationId,
            value: pipeline.fixedInput,
            createdAtSec: completedAtSec,
            verifiedAtSec: completedAtSec,
          },
          {
            kind: "fact-set",
            // v2 archives only the reviewed extension: compiled facts are
            // deterministically rebuilt from (base-input, extension) at gate
            // replay time and bound by factSetDigest, and archiving the
            // compiled copy pushed the artifact past the D1 row budget once
            // every asset became rateable.
            identity: pipeline.candidate.factSetDigest,
            value: { schemaVersion: 2, extension: pipeline.extension },
            createdAtSec: completedAtSec,
            verifiedAtSec: completedAtSec,
          },
          {
            kind: "policy",
            identity: pipeline.candidate.policy.semanticDigest,
            value: V9_CANDIDATE_POLICY_V1,
            createdAtSec: completedAtSec,
            verifiedAtSec: completedAtSec,
          },
          {
            kind: "evaluation-build",
            identity: pipeline.candidate.evaluationBuildDigest,
            value: { manifest: SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST },
            createdAtSec: completedAtSec,
            verifiedAtSec: completedAtSec,
          },
          {
            kind: "result",
            identity: pipeline.candidate.resultDigest,
            value: {
              schemaVersion: 2,
              evaluatedSet: pipeline.evaluatedSet,
              candidate: pipeline.candidate,
              envelopeCore,
            },
            createdAtSec: completedAtSec,
            verifiedAtSec: completedAtSec,
          },
        ],
        { signal: shadowSignal },
      );
      envelope = rebuildSafetyScoreV9ShadowEnvelope({
        candidate: envelope.candidate,
        core: envelopeCore,
        replayArtifacts: getSafetyScoreV9LocalArtifactBundleReferences(localArtifactBundle),
      });
      diff = buildSafetyScoreV9DiffReport({
        generatedAtSec: completedAtSec,
        expectedActiveIds,
        v8,
        v9: envelope,
        topCutoffIds: supply.topCutoffIds,
        downstreamThresholds: downstreamThresholds(),
        supplyUsdById: supply.supplyUsdById,
        reviewDispositionsByKey,
        reviewCarriesByClassKey,
      });
    }

    if (archiveSelectionReasons.length > 0) {
      daily = buildSafetyScoreV9ShadowDailySuccess({
        utcDay,
        selectedAtSec: completedAtSec,
        updatedAtSec: completedAtSec,
        previous,
        envelope,
        diff,
        archiveSelectionReasons,
        artifactKeys: getSafetyScoreV9LocalArtifactBundleArtifacts(localArtifactBundle!).map(
          (artifact) => artifact.artifactKey,
        ),
      });
    }
    const pendingReviewCount = diff.summary.pendingReviewCount;
    stage = "shadow-write";
    await persistSafetyScoreV9ShadowState(input.db, {
      artifacts: localArtifactBundle === undefined ? [] : undefined,
      localArtifactBundle,
      daily,
      envelope,
      diff,
      signal: shadowSignal,
    });
    return {
      status: "published",
      attemptId: currentAttemptId,
      utcDay,
      publicationGenerationId,
      candidateId,
      qualifying: qualification.qualifies,
      qualificationBlockers: qualification.blockers,
      pendingReviewCount,
      archiveSelectionReasons,
    };
  } catch (error) {
    const failureStage: SafetyScoreV9ShadowFailureStage = shadowSignal.aborted ? "aborted" : stage;
    const recordedAtSec =
      input.nowSec !== undefined && Number.isInteger(input.nowSec) && input.nowSec >= 0
        ? Math.max(startedAtSec, input.nowSec)
        : Math.max(startedAtSec, fallbackNowSec());
    const failure = safeFailure(error, failureStage);
    try {
      await persistFailure({
        db: input.db,
        utcDay,
        atSec: recordedAtSec,
        previous,
        stage: failureStage,
        failure,
        signal: input.signal?.aborted ? undefined : input.signal,
      });
    } catch {
      // V8 has already committed. Shadow retention remains best effort and
      // must not turn the active publication into a failure.
    }
    return { status: "failed", attemptId: currentAttemptId, utcDay, stage: failureStage, ...failure };
  }
}
