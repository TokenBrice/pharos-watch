import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import {
  CRON_INTERVALS,
  SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC,
} from "@shared/lib/cron-jobs";
import {
  V9_CONSUMER_SCORE_THRESHOLD_REGISTRY,
  V9_SHADOW_DAILY_START_OFFSET_SEC,
} from "@shared/lib/safety-score-v9/operational-gate";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { sha256HexFromUtf8Chunks } from "@shared/lib/sha256";
import {
  stableJsonStringifyChunksV1,
  stableJsonStringifyV1,
} from "@shared/lib/stable-json";
import type { ReportCard } from "@shared/types/report-cards";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { V9_RELEASE_COVERAGE_FLOORS } from "@shared/types/safety-score-v9-coverage";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";
import type { ReportCardPublicationCompleteness } from "./report-card-publication";
import {
  buildSafetyScoreV9ShadowCandidateFromNormalizedInput,
  type SafetyScoreV9ShadowCandidateResult,
} from "./safety-score-v9-candidate";
import {
  loadSafetyScoreV9MovementReviewCarries,
  loadSafetyScoreV9MovementReviewDispositions,
} from "./safety-score-v9-movement-reviews";
import {
  buildSafetyScoreV9DiffReport,
  buildSafetyScoreV9ShadowDailyFailure,
  buildSafetyScoreV9ShadowDailySuccess,
  buildSafetyScoreV9ShadowEnvelope,
  SAFETY_SCORE_V9_REQUIRED_SHADOW_COVERAGE_FLOOR_IDS,
  safetyScoreV9ShadowLastSuccessfulAttemptAtSec,
  safetyScoreV9UtcDay,
  type SafetyScoreV8ComparableSnapshot,
  type SafetyScoreV9CoverageFloor,
  type SafetyScoreV9DownstreamThreshold,
  type SafetyScoreV9ShadowDaily,
  type SafetyScoreV9ShadowFailureStage,
} from "./safety-score-v9-shadow";
import {
  loadSafetyScoreV9ShadowDaily,
  persistSafetyScoreV9ShadowState,
} from "./safety-score-v9-store";

export const SAFETY_SCORE_V9_SHADOW_ATTEMPT_PREFIX = "safety-score-v9-shadow";

/**
 * Minimum age of the day's latest success before the quarter-hourly caller
 * re-runs the shadow. Thirty minutes yields up to 48 refreshes per UTC day for
 * active calibration while still skipping every other V8 publication. The
 * daily summary remains one row per day and each successful refresh replaces
 * its selected observation.
 */
export { SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";
export const SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC = V9_SHADOW_DAILY_START_OFFSET_SEC;
export const SAFETY_SCORE_V9_SHADOW_TIMEOUT_MS = 2 * 60_000;
const SAFETY_SCORE_V9_SHADOW_CALLER_INTERVAL_SEC = CRON_INTERVALS["publish-report-card-cache"];

export interface RunSafetyScoreV9ShadowInput {
  db: D1Database;
  fixedInput: unknown;
  prepareFixedInput?: (
    fixedInput: Readonly<ReportCardsFixedInput>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  v8Cards: readonly ReportCard[];
  v8Publication: ReportCardPublicationCompleteness;
  v8MethodologyVersion: string;
  signal?: AbortSignal;
  nowSec?: number;
}

export type SafetyScoreV9ShadowRunResult =
  | {
      status: "published";
      attemptId: string;
      utcDay: string;
      publicationGenerationId: string;
      candidateId: string;
      pendingReviewCount: number;
    }
  | {
      status: "skipped";
      attemptId: string;
      utcDay: string;
      reason: "refresh-interval-not-elapsed";
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

function fixedInputWithoutV9Enrichment(input: Readonly<ReportCardsFixedInput>) {
  const {
    safetyScoreV9SupplyAttributionById: _v9SupplyAttribution,
    evidenceJournalById: _evidenceJournal,
    supplyAttributionJournalById: _supplyAttributionJournal,
    pegProvenanceById: _pegProvenance,
    ...baseInput
  } = input;
  return baseInput;
}

function fixedInputWithoutV9EnrichmentDigest(input: Readonly<ReportCardsFixedInput>): string {
  return sha256HexFromUtf8Chunks(
    stableJsonStringifyChunksV1(fixedInputWithoutV9Enrichment(input)),
  );
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

function shadowCallerSlotSec(atSec: number): number {
  return Math.floor(atSec / SAFETY_SCORE_V9_SHADOW_CALLER_INTERVAL_SEC) *
    SAFETY_SCORE_V9_SHADOW_CALLER_INTERVAL_SEC;
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

function observationCoverageFloors(
  observedCount: number,
  expectedCount: number,
  rateableCount: number,
): SafetyScoreV9CoverageFloor[] {
  const exactCount = observedCount === expectedCount;
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
          ? "The V9 candidate meets the configured active-asset rateability check"
          : "The V9 candidate is below the configured active-asset rateability check",
    },
    {
      id: "ratified-release-coverage",
      status: "pass",
      observed: 1,
      required: "retired",
      detail: "Retired activation prerequisite retained only for shadow-history compatibility",
    },
    {
      id: "scheduled-start-latency",
      status: "pass",
      observed: 1,
      required: "retired",
      detail: "Retired start-window prerequisite retained only for shadow-history compatibility",
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

function supplyProjection(pipeline: SafetyScoreV9ShadowCandidateResult): {
  supplyUsdById: Record<string, number>;
  topCutoffIds: Set<string>;
} {
  const supplies = Object.entries(pipeline.supplyUsdById)
    .map(([id, supplyUsd]) => ({ id, supplyUsd }))
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
    let fixedInput = normalizeFixedInput(input.fixedInput);
    startedAtSec = nowSecAtLeast(fixedInput.clockSec, input.nowSec);
    const scheduledForSec = scheduledForUtcDay(fixedInput.clockSec);
    utcDay = safetyScoreV9UtcDay(scheduledForSec);

    stage = "scheduler";
    previous = await loadSafetyScoreV9ShadowDaily(input.db, utcDay, shadowSignal);
    currentAttemptId = attemptId(utcDay, previous);
    // The daily summary stays one row while bounded intra-day refreshes keep
    // the canonical candidate current. A younger success skips to bound
    // compute and writes.
    const lastSuccessfulAtSec = previous === null ? null : safetyScoreV9ShadowLastSuccessfulAttemptAtSec(previous);
    if (
      lastSuccessfulAtSec !== null &&
      shadowCallerSlotSec(startedAtSec) - shadowCallerSlotSec(lastSuccessfulAtSec) <
        SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC
    ) {
      return {
        status: "skipped",
        attemptId: currentAttemptId,
        utcDay,
        reason: "refresh-interval-not-elapsed",
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

    stage = "v9-enrichment";
    if (input.prepareFixedInput) {
      const preparedFixedInput = normalizeFixedInput(
        await input.prepareFixedInput(fixedInput, shadowSignal),
      );
      if (
        fixedInputWithoutV9EnrichmentDigest(preparedFixedInput) !==
        fixedInputWithoutV9EnrichmentDigest(fixedInput)
      ) {
        throw new Error("Safety Score v9 preparation changed the authoritative V8 fixed input");
      }
      fixedInput = preparedFixedInput;
    }
    stage = "compile";
    const pipeline = buildSafetyScoreV9ShadowCandidateFromNormalizedInput({
      fixedInput,
      publishedAtSec: fixedInput.clockSec,
    });
    const publicationGenerationId = pipeline.candidate.publicationGenerationId;
    const candidateId = pipeline.candidate.candidateId;

    const completedAtSec = nowSecAtLeast(startedAtSec, input.nowSec);
    const expectedActiveIds = [...fixedInput.activeAssetIds].sort(compareText);
    stage = "serialize";
    const floors = observationCoverageFloors(
      pipeline.candidate.cards.length,
      expectedActiveIds.length,
      pipeline.candidate.completeness.ratedCount,
    );
    const baseEnvelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: pipeline.candidate,
      expectedActiveIds,
      compilerFactSchemaDigest: pipeline.compilerFactSchemaDigest,
      producerCapabilityDigest: pipeline.producerCapabilityDigest,
      coverageFloors: floors,
    });
    const supply = supplyProjection(pipeline);
    const v8 = buildV8ComparableSnapshot({
      fixedInput,
      cards: input.v8Cards,
      publication: input.v8Publication,
      methodologyVersion: input.v8MethodologyVersion,
    });

    const pendingReviewKeys = (() => {
      const pendingDiff = buildSafetyScoreV9DiffReport({
        generatedAtSec: completedAtSec,
        expectedActiveIds,
        v8,
        v9: baseEnvelope,
        topCutoffIds: supply.topCutoffIds,
        downstreamThresholds: downstreamThresholds(),
        supplyUsdById: supply.supplyUsdById,
      });
      return {
        exact: pendingDiff.cards.flatMap((card) =>
          card.review.key === null ? [] : [card.review.key],
        ),
        class: pendingDiff.cards.flatMap((card) =>
          card.review.classKey === null ? [] : [card.review.classKey],
        ),
      };
    })();
    const [reviewDispositionsByKey, reviewCarriesByClassKey] = await Promise.all([
      loadSafetyScoreV9MovementReviewDispositions(
        input.db,
        pendingReviewKeys.exact,
        shadowSignal,
      ),
      loadSafetyScoreV9MovementReviewCarries(
        input.db,
        pendingReviewKeys.class,
        shadowSignal,
      ),
    ]);
    const diff = buildSafetyScoreV9DiffReport({
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
    const unresolvedCriticalMovementIds = diff.cards
      .filter(
        (card) =>
          card.review.status === "pending" ||
          card.review.disposition === "producer-data-gap" ||
          card.review.disposition === "defect",
      )
      .map((card) => card.id);
    const envelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: pipeline.candidate,
      expectedActiveIds,
      compilerFactSchemaDigest: pipeline.compilerFactSchemaDigest,
      producerCapabilityDigest: pipeline.producerCapabilityDigest,
      coverageFloors: floors,
      unresolvedCriticalMovementIds,
    });
    const daily = buildSafetyScoreV9ShadowDailySuccess({
      utcDay,
      selectedAtSec: completedAtSec,
      updatedAtSec: completedAtSec,
      previous,
      envelope,
      diff,
    });
    const pendingReviewCount = diff.summary.pendingReviewCount;
    stage = "shadow-write";
    await persistSafetyScoreV9ShadowState(input.db, {
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
      pendingReviewCount,
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
