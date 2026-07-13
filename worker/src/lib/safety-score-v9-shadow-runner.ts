import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { ReportCard } from "@shared/types/report-cards";
import type { V9Grade } from "@shared/types/safety-score-v9";
import type { SafetyScoreV9ReplayArtifactKind } from "./safety-score-v9-shadow";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";
import type { ReportCardPublicationCompleteness } from "./report-card-publication";
import { buildSafetyScoreV9BaselineExtension } from "./safety-score-v9-extension";
import { buildSafetyScoreV9Candidate, type SafetyScoreV9CandidatePipelineResult } from "./safety-score-v9-candidate";
import {
  buildSafetyScoreV9DiffReport,
  buildSafetyScoreV9ShadowAttempt,
  buildSafetyScoreV9ShadowDay,
  buildSafetyScoreV9ShadowEnvelope,
  projectSafetyScoreV9ShadowEnvelopeCore,
  rebuildSafetyScoreV9ShadowEnvelope,
  safetyScoreV9UtcDay,
  type SafetyScoreV8ComparableSnapshot,
  type SafetyScoreV9CoverageFloor,
  type SafetyScoreV9DownstreamThreshold,
  type SafetyScoreV9ReplayArtifact,
  type SafetyScoreV9ShadowAttempt,
  type SafetyScoreV9ShadowDay,
  type SafetyScoreV9ShadowEnvelopeCore,
} from "./safety-score-v9-shadow";
import {
  buildSafetyScoreV9ReplayArtifact,
  loadSafetyScoreV9ShadowHistory,
  parseSafetyScoreV9ReplayArtifact,
  persistSafetyScoreV9ShadowState,
  type SafetyScoreV9StoredReplayArtifact,
} from "./safety-score-v9-store";
import { loadSafetyScoreV9MovementReviewDispositions } from "./safety-score-v9-movement-reviews";

export const SAFETY_SCORE_V9_SHADOW_PUBLICATION_EPOCH = 0;
export const SAFETY_SCORE_V9_SHADOW_ATTEMPT_PREFIX = "safety-score-v9-shadow:scheduled";
export const SAFETY_SCORE_V9_SHADOW_MAX_START_DELAY_SEC = 60 * 60;

export interface RunSafetyScoreV9ShadowInput {
  db: D1Database;
  fixedInput: unknown;
  v8Cards: readonly ReportCard[];
  v8Publication: ReportCardPublicationCompleteness;
  v8MethodologyVersion: string;
  signal?: AbortSignal;
  nowSec?: number;
  releaseCandidateId?: string;
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
    }
  | {
      status: "skipped";
      attemptId: string;
      utcDay: string;
      reason: "attempt-already-recorded";
      qualifying: boolean;
    }
  | {
      status: "failed";
      attemptId: string;
      utcDay: string;
      stage: SafetyScoreV9ShadowFailureStage;
      code: string;
      message: string;
    };

type SafetyScoreV9ShadowFailureStage =
  | "scheduler"
  | "base-input"
  | "v8-publication"
  | "v9-enrichment"
  | "compile"
  | "score"
  | "serialize"
  | "artifact-retention"
  | "shadow-write"
  | "aborted";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nowSecAtLeast(minimum: number, override?: number): number {
  const value = override ?? Math.floor(Date.now() / 1_000);
  if (!Number.isInteger(value) || value < 0) throw new Error("Safety Score v9 shadow clock must be epoch seconds");
  return Math.max(minimum, value);
}

function scheduledForUtcDay(clockSec: number): number {
  const day = safetyScoreV9UtcDay(clockSec);
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1_000);
}

function scheduledAttemptId(utcDay: string): string {
  return `${SAFETY_SCORE_V9_SHADOW_ATTEMPT_PREFIX}:${utcDay}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
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
  scheduledForSec: number,
  startedAtSec: number,
): SafetyScoreV9CoverageFloor[] {
  const exactCount = observedCount === expectedCount;
  const startDelaySec = Math.max(0, startedAtSec - scheduledForSec);
  const floors: SafetyScoreV9CoverageFloor[] = [
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
      id: "scheduled-start-latency",
      status: startDelaySec <= SAFETY_SCORE_V9_SHADOW_MAX_START_DELAY_SEC ? "pass" : "fail",
      observed: startDelaySec,
      required: `<= ${SAFETY_SCORE_V9_SHADOW_MAX_START_DELAY_SEC} seconds after the UTC daily boundary`,
      detail:
        startDelaySec <= SAFETY_SCORE_V9_SHADOW_MAX_START_DELAY_SEC
          ? "The daily shadow attempt began inside the preregistered start window"
          : "The daily shadow attempt began too late to represent a complete prospective UTC day",
    },
  ];
  return floors.sort((left, right) => compareText(left.id, right.id));
}

function gradeThresholds(): SafetyScoreV9DownstreamThreshold[] {
  return V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds
    .filter((threshold) => threshold.minScore > 0)
    .map((threshold: { grade: Exclude<V9Grade, "NR">; minScore: number }) => ({
      id: `grade-minimum:${threshold.grade}`,
      label: `${threshold.grade} minimum`,
      score: threshold.minScore,
      comparison: "at-least" as const,
    }));
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

async function buildReplayArtifacts(
  pipeline: SafetyScoreV9CandidatePipelineResult,
  createdAtSec: number,
  signal?: AbortSignal,
): Promise<{ stored: SafetyScoreV9StoredReplayArtifact[]; references: SafetyScoreV9ReplayArtifact[] }> {
  const values: readonly { kind: SafetyScoreV9ReplayArtifactKind; identity: string; value: unknown }[] = [
    {
      kind: "base-input",
      identity: pipeline.candidate.baseInputGenerationId,
      value: pipeline.fixedInput,
    },
    {
      kind: "fact-set",
      identity: pipeline.candidate.factSetDigest,
      value: { schemaVersion: 1, extension: pipeline.extension, compiledFacts: pipeline.compiledFacts },
    },
    {
      kind: "policy",
      identity: pipeline.candidate.policy.semanticDigest,
      value: V9_CANDIDATE_POLICY_V1,
    },
    {
      kind: "evaluation-build",
      identity: pipeline.candidate.evaluationBuildDigest,
      value: {
        manifest: SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST,
        compilerFactSchemaIdentity: pipeline.compilerFactSchemaIdentity,
        producerCapabilityIdentity: pipeline.producerCapabilityIdentity,
      },
    },
  ];
  const stored: SafetyScoreV9StoredReplayArtifact[] = [];
  const references: SafetyScoreV9ReplayArtifact[] = [];
  for (const value of values) {
    const artifact = await buildSafetyScoreV9ReplayArtifact(
      { ...value, createdAtSec, verifiedAtSec: createdAtSec },
      { signal },
    );
    const parsed = await parseSafetyScoreV9ReplayArtifact(artifact, {
      expectedKind: value.kind,
      expectedIdentity: value.identity,
      signal,
    });
    stored.push(artifact);
    references.push(parsed.reference);
  }
  return { stored, references };
}

async function buildResultReplayArtifact(
  pipeline: SafetyScoreV9CandidatePipelineResult,
  envelopeCore: SafetyScoreV9ShadowEnvelopeCore,
  createdAtSec: number,
  signal?: AbortSignal,
): Promise<{ stored: SafetyScoreV9StoredReplayArtifact; reference: SafetyScoreV9ReplayArtifact }> {
  const stored = await buildSafetyScoreV9ReplayArtifact(
    {
      kind: "result",
      identity: pipeline.candidate.resultDigest,
      value: {
        schemaVersion: 2,
        evaluatedSet: pipeline.evaluatedSet,
        candidate: pipeline.candidate,
        envelopeCore,
      },
      createdAtSec,
      verifiedAtSec: createdAtSec,
    },
    { signal },
  );
  const parsed = await parseSafetyScoreV9ReplayArtifact(stored, {
    expectedKind: "result",
    expectedIdentity: pipeline.candidate.resultDigest,
    signal,
  });
  return { stored, reference: parsed.reference };
}

function mergeAttempt(day: SafetyScoreV9ShadowDay | null, attempt: SafetyScoreV9ShadowAttempt): SafetyScoreV9ShadowDay {
  const attempts = [...(day?.attempts ?? []).filter((entry) => entry.attemptId !== attempt.attemptId), attempt];
  return buildSafetyScoreV9ShadowDay({
    utcDay: attempt.utcDay,
    expectedScheduledAttemptIds: [scheduledAttemptId(attempt.utcDay)],
    attempts,
  });
}

function safeFailure(error: unknown, stage: SafetyScoreV9ShadowFailureStage): { code: string; message: string } {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    code: `safety-score-v9-shadow-${stage}-${name}`.slice(0, 160),
    message: (rawMessage.trim() || "Safety Score v9 shadow attempt failed").slice(0, 500),
  };
}

/**
 * Runs one candidate-only V9 shadow generation after the exact v8 publication
 * has committed. Every error is converted into shadow history and returned to
 * the caller; this function never authorizes or mutates the active model.
 */
export async function runSafetyScoreV9ShadowAfterV8Publication(
  input: RunSafetyScoreV9ShadowInput,
): Promise<SafetyScoreV9ShadowRunResult> {
  const fixedInput = normalizeFixedInput(input.fixedInput);
  const scheduledForSec = scheduledForUtcDay(fixedInput.clockSec);
  const utcDay = safetyScoreV9UtcDay(scheduledForSec);
  const attemptId = scheduledAttemptId(utcDay);
  const existingDay =
    (
      await loadSafetyScoreV9ShadowHistory(input.db, {
        fromUtcDay: utcDay,
        toUtcDay: utcDay,
        limit: 1,
        signal: input.signal,
      })
    )[0] ?? null;
  const existingAttempt = existingDay?.attempts.find((attempt) => attempt.attemptId === attemptId);
  if (existingAttempt) {
    return {
      status: "skipped",
      attemptId,
      utcDay,
      reason: "attempt-already-recorded",
      qualifying: existingAttempt.qualification?.qualifies ?? false,
    };
  }

  const startedAtSec = nowSecAtLeast(fixedInput.clockSec, input.nowSec);
  let stage: SafetyScoreV9ShadowFailureStage = "v9-enrichment";
  try {
    const extension = buildSafetyScoreV9BaselineExtension(fixedInput);
    stage = "compile";
    const pipeline = buildSafetyScoreV9Candidate({
      fixedInput,
      extension,
      publishedAtSec: fixedInput.clockSec,
      publicationEpoch: SAFETY_SCORE_V9_SHADOW_PUBLICATION_EPOCH,
      releaseCandidateId: input.releaseCandidateId,
    });

    stage = "artifact-retention";
    const completedAtSec = nowSecAtLeast(startedAtSec, input.nowSec);
    const artifacts = await buildReplayArtifacts(pipeline, completedAtSec, input.signal);
    const expectedActiveIds = [...fixedInput.activeAssetIds].sort(compareText);
    const floors = releaseCoverageFloors(
      pipeline.candidate.cards.length,
      expectedActiveIds.length,
      scheduledForSec,
      startedAtSec,
    );
    const releaseBlockers: string[] = [];
    const provisionalEnvelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: pipeline.candidate,
      expectedActiveIds,
      compilerFactSchemaDigest: pipeline.compilerFactSchemaDigest,
      producerCapabilityDigest: pipeline.producerCapabilityDigest,
      coverageFloors: floors,
      unresolvedReleaseBlockers: releaseBlockers,
      replayArtifacts: artifacts.references,
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
      v9: provisionalEnvelope,
      topCutoffIds: supply.topCutoffIds,
      downstreamThresholds: gradeThresholds(),
      supplyUsdById: supply.supplyUsdById,
    });
    const persistedReviewDispositions = await loadSafetyScoreV9MovementReviewDispositions(
      input.db,
      pendingDiff.cards.flatMap((card) => (card.review.key === null ? [] : [card.review.key])),
      input.signal,
    );
    const reviewDispositionsByKey = persistedReviewDispositions;
    const provisionalDiff = buildSafetyScoreV9DiffReport({
      generatedAtSec: completedAtSec,
      expectedActiveIds,
      v8,
      v9: provisionalEnvelope,
      topCutoffIds: supply.topCutoffIds,
      downstreamThresholds: gradeThresholds(),
      supplyUsdById: supply.supplyUsdById,
      reviewDispositionsByKey,
    });
    const unresolvedCriticalMovementIds = provisionalDiff.cards
      .filter(
        (card) =>
          card.review.status === "pending" ||
          card.review.disposition === "producer-data-gap" ||
          card.review.disposition === "defect",
      )
      .map((card) => card.id);
    const envelopeWithoutResult = buildSafetyScoreV9ShadowEnvelope({
      candidate: pipeline.candidate,
      expectedActiveIds,
      compilerFactSchemaDigest: pipeline.compilerFactSchemaDigest,
      producerCapabilityDigest: pipeline.producerCapabilityDigest,
      coverageFloors: floors,
      unresolvedReleaseBlockers: releaseBlockers,
      unresolvedCriticalMovementIds,
      replayArtifacts: artifacts.references,
    });
    const envelopeCore = projectSafetyScoreV9ShadowEnvelopeCore(envelopeWithoutResult);
    const resultArtifact = await buildResultReplayArtifact(
      pipeline,
      envelopeCore,
      completedAtSec,
      input.signal,
    );
    artifacts.stored.push(resultArtifact.stored);
    artifacts.references.push(resultArtifact.reference);
    const envelope = rebuildSafetyScoreV9ShadowEnvelope({
      candidate: pipeline.candidate,
      core: envelopeCore,
      replayArtifacts: artifacts.references,
    });
    const diff = buildSafetyScoreV9DiffReport({
      generatedAtSec: completedAtSec,
      expectedActiveIds,
      v8,
      v9: envelope,
      topCutoffIds: supply.topCutoffIds,
      downstreamThresholds: gradeThresholds(),
      supplyUsdById: supply.supplyUsdById,
      reviewDispositionsByKey,
    });
    const attempt = buildSafetyScoreV9ShadowAttempt({
      attemptId,
      trigger: "scheduled",
      retryOfAttemptId: null,
      scheduledForSec,
      startedAtSec,
      completedAtSec,
      recordedAtSec: completedAtSec,
      outcome: "succeeded",
      envelope,
    });
    const day = mergeAttempt(existingDay, attempt);

    stage = "shadow-write";
    await persistSafetyScoreV9ShadowState(input.db, {
      artifacts: artifacts.stored,
      attempt,
      day,
      envelope,
      diff,
      updatedAtSec: completedAtSec,
      signal: input.signal,
    });
    return {
      status: "published",
      attemptId,
      utcDay,
      publicationGenerationId: pipeline.candidate.publicationGenerationId,
      candidateId: pipeline.candidate.candidateId,
      qualifying: attempt.qualification?.qualifies ?? false,
      qualificationBlockers: attempt.qualification?.blockers ?? [],
      pendingReviewCount: diff.summary.pendingReviewCount,
    };
  } catch (error) {
    const recordedAtSec = nowSecAtLeast(startedAtSec, input.nowSec);
    const failure = safeFailure(error, stage);
    const attempt = buildSafetyScoreV9ShadowAttempt({
      attemptId,
      trigger: "scheduled",
      retryOfAttemptId: null,
      scheduledForSec,
      startedAtSec,
      completedAtSec: recordedAtSec,
      recordedAtSec,
      outcome: "failed",
      failure: { stage, ...failure },
    });
    try {
      await persistSafetyScoreV9ShadowState(input.db, {
        attempt,
        day: mergeAttempt(existingDay, attempt),
        updatedAtSec: recordedAtSec,
        signal: input.signal,
      });
    } catch {
      // The active v8 publication has already committed. A shadow-store
      // failure is returned for cron diagnostics and must never unwind v8.
    }
    return { status: "failed", attemptId, utcDay, stage, ...failure };
  }
}
