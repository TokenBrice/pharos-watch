import { buildReportCardsV9DependencyGraph, type ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type {
  SafetyScoreV9CurrentCard,
  SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-public";
import { scoreToV9Grade } from "@shared/types/safety-score-v9-grade";

const digest = (character: string) => character.repeat(64);

export function makeWorkerV9Card(
  overrides: Partial<SafetyScoreV9CurrentCard> = {},
): SafetyScoreV9CurrentCard {
  const score = overrides.score === undefined ? 80 : overrides.score;
  const grade = overrides.grade ?? scoreToV9Grade(score);
  const reviewedPillarScores = overrides.pillars === undefined
    ? []
    : Object.values(overrides.pillars)
        .map((pillar) => pillar.score)
        .filter((pillarScore): pillarScore is number => pillarScore !== null);
  const qualityScore = overrides.qualityScore === undefined
    ? reviewedPillarScores.length === 0
      ? 82
      : reviewedPillarScores.reduce((sum, pillarScore) => sum + pillarScore, 0) /
        reviewedPillarScores.length
    : overrides.qualityScore;
  const pegMultiplier = overrides.pegMultiplier === undefined ? 0.98 : overrides.pegMultiplier;
  const pegAdjustedScore =
    overrides.pegAdjustedScore === undefined ? score : overrides.pegAdjustedScore;
  const pillar = (pillarScore: number | null) => ({
    score: pillarScore,
    evidenceLevel: "adequate" as const,
    freshness: "current" as const,
    components: ["reviewed"],
    reasons: [],
  });
  const pillars = overrides.pillars ?? {
    backing: pillar(qualityScore === null ? null : Math.max(0, qualityScore - 2)),
    exit: pillar(qualityScore),
    control: pillar(qualityScore === null ? null : Math.min(100, qualityScore + 2)),
  };
  const breakdowns =
    overrides.breakdowns !== undefined
      ? overrides.breakdowns
      : score === null ||
          pillars.backing.score === null ||
          pillars.exit.score === null ||
          pillars.control.score === null
        ? null
        : {
            backing: {
              evaluatedScore: pillars.backing.score,
              publishedScore: pillars.backing.score,
              aggregationWeight: 0.4,
              groups: [{
                key: "reserves" as const,
                label: "Reserves",
                score: pillars.backing.score,
                effectiveWeight: 1,
              }],
              components: [{
                key: "reserve:reviewed",
                label: "Reviewed reserves",
                source: "reserve-exposure" as const,
                score: pillars.backing.score,
                effectiveWeight: 1,
                weightedContribution: pillars.backing.score,
                observationState: "known" as const,
              }],
              adjustments: [],
            },
            exit: {
              evaluatedScore: pillars.exit.score,
              publishedScore: pillars.exit.score,
              aggregationWeight: 0.35,
              stressRequest: {
                requestedNotionalUsd: 1_000_000,
                maxCostBps: 200,
                comparisonWindowSec: 86_400,
              },
              primaryRoute: {
                key: "redemption:reviewed",
                label: "Protocol redemption",
                routeFamily: "protocol-redemption" as const,
                score: pillars.exit.score,
                components: [
                  ["access", "Access", 0.2],
                  ["settlement", "Settlement", 0.15],
                  ["executionCertainty", "Execution certainty", 0.15],
                  ["capacity", "Capacity", 0.25],
                  ["outputAssetQuality", "Output asset quality", 0.15],
                  ["cost", "Cost", 0.1],
                ].map(([key, label, weight]) => ({
                  key: key as "access" | "settlement" | "executionCertainty" | "capacity" | "outputAssetQuality" | "cost",
                  label: label as string,
                  score: pillars.exit.score!,
                  weight: weight as number,
                  weightedContribution: pillars.exit.score! * (weight as number),
                })),
                confidenceFactor: 1,
                eligibilityMultiplier: 1,
                capsApplied: [],
              },
              diversification: null,
              alternatives: [],
              adjustments: [],
            },
            control: {
              evaluatedScore: pillars.control.score,
              publishedScore: pillars.control.score,
              aggregationWeight: 0.25,
              method: "minimum-binding-component" as const,
              components: [{
                key: "control:reviewed",
                label: "Reviewed control",
                kind: "mint" as const,
                score: pillars.control.score,
                binding: true,
                posture: "distributed",
              }],
              adjustments: [],
            },
          };
  const defaultWeakestPillar = (
    Object.entries(pillars) as Array<
      ["backing" | "exit" | "control", (typeof pillars)["backing"]]
    >
  )
    .filter((entry) => entry[1].score !== null)
    .sort((left, right) => left[1].score! - right[1].score!)[0];
  const weakestPillar = overrides.weakestPillar !== undefined
    ? overrides.weakestPillar
    : qualityScore === null || defaultWeakestPillar === undefined
      ? null
      : {
          pillar: defaultWeakestPillar[0],
          score: defaultWeakestPillar[1].score!,
        };
  const card = {
    id: "usdc-circle",
    score,
    grade,
    qualityScore,
    pegMultiplier,
    pegAdjustedScore,
    pillars,
    weakestPillar,
    caps: [],
    bindingCap: null,
    nrReasons: [],
    reasonCodes: [],
    evidence: { level: "adequate", freshness: "current", reasons: [] },
    accessPosture: {
      transfer: "restrictable",
      freezeExposure: "direct",
      primaryExit: "eligibility-gated",
      governance: "single-entity",
      unknownFields: [],
      signals: [],
      reasons: [],
    },
    dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
    stressStateDigest: null,
    breakdowns,
    ...overrides,
  } satisfies Omit<SafetyScoreV9CurrentCard, "scoreTrace">;
  const hasScoreStages =
    card.score !== null &&
    card.qualityScore !== null &&
    card.pegMultiplier !== null &&
    card.pegAdjustedScore !== null &&
    card.weakestPillar !== null;

  return {
    ...card,
    scoreTrace: overrides.scoreTrace ?? {
      schemaVersion: 3,
      legacyAliases: {
        qualityScore: "weighted-pillar-mean",
        pegAdjustedScore: "post-deployment-pre-cap-score",
        score: "post-cap-public-score",
      },
      aggregation: hasScoreStages
        ? {
            method: "smooth-bounded-headroom",
            score: card.qualityScore!,
            weightedPillarMean: card.qualityScore!,
            weakestPillar: card.weakestPillar!.pillar,
            weakestScore: card.weakestPillar!.score,
            headroom: 20,
          }
        : null,
      stages: {
        weightedPillarMean: card.qualityScore,
        aggregatedQualityScore: hasScoreStages ? card.qualityScore : null,
        pegMultiplier: card.pegMultiplier,
        baseAssetScore: card.pegAdjustedScore,
        deploymentAdjustedScore: card.pegAdjustedScore,
        deploymentAdjustmentPoints: hasScoreStages ? 0 : null,
        preCapScore: card.pegAdjustedScore,
        publishedScore: card.score,
      },
      deploymentRisk: {
        method: "holder-slice-exposure-weighted-v2",
        totalAdjustmentPoints: hasScoreStages ? 0 : null,
        adjustments: [],
        unresolvedExposures: [],
      },
      adverseAttribution: {
        semantics: "causal-measured-adverse-v1",
        items: [],
      },
      boundedUncertaintyAttribution: {
        semantics: "causal-bounded-uncertainty-v1",
        items: [],
      },
      evidenceResponsibility: {
        semantics: "limiting-fact-owner-v1",
        totalFactCount: 0,
        summaries: [
          { responsibility: "integration-missing", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
          { responsibility: "issuer-undisclosed", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
          { responsibility: "measured-adverse", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
          { responsibility: "method-unsupported", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
          { responsibility: "producer-failed", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        ],
      },
      scoreAdjustments: [],
      wrapperParentLimit: null,
    },
  };
}

export function makeWorkerReportCardsV9Response(
  overrides: Partial<ReportCardsV9Response> = {},
): ReportCardsV9Response {
  const cards = overrides.cards ?? [makeWorkerV9Card()];
  const identity = overrides.safetyScoreIdentity ?? {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "9.0",
    policyId: "safety-score-v9",
    policyDigest: digest("a"),
    evaluationBuildDigest: digest("b"),
    baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
    publicationGenerationId: "report-cards:v9:1",
  };
  const updatedAt = overrides.updatedAt ?? 110;
  return {
    model: "v9",
    schemaVersion: 4,
    lifecycle: "active",
    safetyScoreIdentity: identity,
    methodology: {
      version: identity.methodologyVersion,
      policy: { id: identity.policyId, semanticDigest: identity.policyDigest },
    },
    asOfSec: 100,
    updatedAt,
    publicationHealth: overrides.publicationHealth ?? {
      schemaVersion: 1,
      status: "current",
      acceptedPublicationGenerationId: identity.publicationGenerationId,
      acceptedAtSec: updatedAt,
      attemptedAtSec: updatedAt,
      heldSinceSec: null,
      reasons: [],
    },
    completeness: {
      expectedCount: cards.length,
      ratedCount: cards.filter((card) => card.grade !== "NR").length,
      notRatedCount: cards.filter((card) => card.grade === "NR").length,
      notRatedIds: cards.filter((card) => card.grade === "NR").map((card) => card.id).sort(),
    },
    source: {
      candidateId: "candidate-v9.0",
      factSetDigest: digest("d"),
      resultDigest: digest("e"),
      sourceGenerations: { registry: "registry-1" },
    },
    cards,
    dependencyGraph: buildReportCardsV9DependencyGraph(cards),
    ...overrides,
  };
}

export const makeReportCardsV9Response = makeWorkerReportCardsV9Response;

export function makeWorkerSafetyScoreV9Publication(
  overrides: Partial<SafetyScoreV9CurrentResponse> = {},
): SafetyScoreV9CurrentResponse {
  const projected = makeWorkerReportCardsV9Response(
    overrides.cards === undefined ? {} : { cards: overrides.cards },
  );
  return {
    model: "v9-critical-path",
    schemaVersion: 5,
    lifecycle: "active",
    candidateId: projected.source.candidateId,
    policyVersion: projected.methodology.version,
    publicationGenerationId:
      projected.safetyScoreIdentity.publicationGenerationId,
    baseInputGenerationId:
      projected.safetyScoreIdentity.baseInputGenerationId,
    factSetDigest: projected.source.factSetDigest,
    resultDigest: projected.source.resultDigest,
    policy: projected.methodology.policy,
    evaluationBuildDigest:
      projected.safetyScoreIdentity.evaluationBuildDigest,
    sourceGenerations: projected.source.sourceGenerations,
    asOfSec: projected.asOfSec,
    publishedAtSec: projected.updatedAt,
    completeness: projected.completeness,
    cards: projected.cards,
    ...overrides,
  };
}
