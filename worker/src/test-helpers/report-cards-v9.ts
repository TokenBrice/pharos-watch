import { buildReportCardsV9DependencyGraph, type ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { scoreToGrade } from "@shared/lib/report-cards";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";

const digest = (character: string) => character.repeat(64);

export function makeWorkerV9Card(
  overrides: Partial<SafetyScoreV9CurrentCard> = {},
): SafetyScoreV9CurrentCard {
  const score = overrides.score === undefined ? 80 : overrides.score;
  const grade = overrides.grade ?? scoreToGrade(score);
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
      schemaVersion: 2,
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
    methodologyVersion: "candidate-v9.0",
    policyId: "safety-score-v9",
    policyDigest: digest("a"),
    evaluationBuildDigest: digest("b"),
    baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
    publicationGenerationId: "report-cards:v9:1",
  };
  return {
    model: "v9",
    schemaVersion: 2,
    lifecycle: "shadow",
    safetyScoreIdentity: identity,
    methodology: {
      version: identity.methodologyVersion,
      policy: { id: identity.policyId, semanticDigest: identity.policyDigest },
    },
    asOfSec: 100,
    updatedAt: 110,
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
