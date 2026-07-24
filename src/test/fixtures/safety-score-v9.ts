import { buildReportCardsV9DependencyGraph, type ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { scoreToGrade } from "@shared/lib/report-cards";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";

const A64 = "a".repeat(64);
const B64 = "b".repeat(64);
const C64 = "c".repeat(64);
const D64 = "d".repeat(64);

export function makeV9Card(
  overrides: Partial<SafetyScoreV9CurrentCard> = {},
): SafetyScoreV9CurrentCard {
  const pillar = (score: number) => ({
    score,
    evidenceLevel: "adequate" as const,
    freshness: "current" as const,
    components: ["reviewed-component"],
    reasons: [],
  });
  const score = overrides.score === undefined ? 84 : overrides.score;
  const grade = overrides.grade ?? scoreToGrade(score);
  const qualityScore =
    overrides.qualityScore === undefined ? 86 : overrides.qualityScore;
  const defaultPillars =
    qualityScore === null
      ? {
          backing: { ...pillar(0), score: null },
          exit: { ...pillar(0), score: null },
          control: { ...pillar(0), score: null },
        }
      : {
          backing: pillar(Math.min(100, qualityScore + 2)),
          exit: pillar(Math.max(0, qualityScore - 2)),
          control: pillar(qualityScore),
        };
  const pillars = overrides.pillars ?? defaultPillars;
  const weakestPillar =
    overrides.weakestPillar !== undefined
      ? overrides.weakestPillar
      : qualityScore === null
        ? null
        : {
            pillar: "exit" as const,
            score: pillars.exit.score!,
          };
  const card = {
    id: "usdc-circle",
    pegMultiplier: 0.98,
    pegAdjustedScore: 84,
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
      signals: ["issuer-controls"],
      reasons: [],
    },
    dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
    stressStateDigest: null,
    ...overrides,
    score,
    grade,
    qualityScore,
    pillars,
    weakestPillar,
  } satisfies Omit<SafetyScoreV9CurrentCard, "scoreTrace">;
  const hasScoreStages =
    card.qualityScore !== null &&
    card.pegMultiplier !== null &&
    card.pegAdjustedScore !== null &&
    card.score !== null &&
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

export function makeReportCardsV9Response(
  overrides: Partial<ReportCardsV9Response> = {},
): ReportCardsV9Response {
  const cards = overrides.cards ?? [makeV9Card()];
  const safetyScoreIdentity = overrides.safetyScoreIdentity ?? {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "candidate-v9.0",
    policyId: "policy-v9",
    policyDigest: A64,
    evaluationBuildDigest: B64,
    baseInputGenerationId: `report-cards-input:v1:${C64}`,
    publicationGenerationId: "v9-publication-1",
  };
  return {
    model: "v9",
    schemaVersion: 2,
    lifecycle: "shadow",
    safetyScoreIdentity,
    methodology: {
      version: safetyScoreIdentity.methodologyVersion,
      policy: { id: safetyScoreIdentity.policyId, semanticDigest: safetyScoreIdentity.policyDigest },
    },
    asOfSec: 1_752_534_000,
    updatedAt: 1_752_534_060,
    completeness: {
      expectedCount: cards.length,
      ratedCount: cards.filter((card) => card.grade !== "NR").length,
      notRatedCount: cards.filter((card) => card.grade === "NR").length,
      notRatedIds: cards.filter((card) => card.grade === "NR").map((card) => card.id).sort(),
    },
    source: {
      candidateId: "candidate-v9.0-2026-07-15",
      factSetDigest: C64,
      resultDigest: D64,
      sourceGenerations: { reportCards: "source-1" },
    },
    cards,
    dependencyGraph: buildReportCardsV9DependencyGraph(cards),
    ...overrides,
  };
}
