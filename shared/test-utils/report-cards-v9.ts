import {
  buildReportCardsV9DependencyGraph,
  type ReportCardsV9Response,
} from "@shared/types/report-cards-v9";
import { scoreToV9Grade } from "@shared/types/safety-score-v9-grade";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";

type V9PillarKey = keyof SafetyScoreV9CurrentCard["pillars"];
type V9Breakdowns = Exclude<SafetyScoreV9CurrentCard["breakdowns"], null>;

export interface ReportCardsV9ResponseFixturePreset {
  safetyScoreIdentity: ReportCardsV9Response["safetyScoreIdentity"];
  defaultUpdatedAt: number;
  asOfSec: number;
  source: ReportCardsV9Response["source"];
}

/**
 * One default card shape for every V9 consumer. The worker and frontend suites
 * used to carry separate presets whose divergences (pillar offsets, weakest
 * pillar selection, breakdown labels, component names) were accidental rather
 * than meaningful; the worker values won because the publication path authors
 * them.
 */
const DEFAULT_SCORE = 80;
const DEFAULT_QUALITY_SCORE = 82;
const DEFAULT_PEG_MULTIPLIER = 0.98;
const PILLAR_COMPONENTS = ["reviewed"] as const;

const EXIT_COMPONENTS = [
  { key: "access", label: "Access", weight: 0.2 },
  { key: "settlement", label: "Settlement", weight: 0.15 },
  { key: "executionCertainty", label: "Execution certainty", weight: 0.15 },
  { key: "capacity", label: "Capacity", weight: 0.25 },
  { key: "outputAssetQuality", label: "Output asset quality", weight: 0.15 },
  { key: "cost", label: "Cost", weight: 0.1 },
] as const;

function buildBreakdowns(
  score: number | null,
  pillars: SafetyScoreV9CurrentCard["pillars"],
): V9Breakdowns | null {
  if (
    score === null ||
    pillars.backing.score === null ||
    pillars.exit.score === null ||
    pillars.control.score === null
  ) {
    return null;
  }

  return {
    backing: {
      evaluatedScore: pillars.backing.score,
      publishedScore: pillars.backing.score,
      aggregationWeight: 0.4,
      adjustments: [],
      groups: [{
        key: "reserves",
        label: "Reserves",
        score: pillars.backing.score,
        effectiveWeight: 1,
      }],
      components: [{
        key: "reserve:reviewed",
        label: "Reviewed reserves",
        source: "reserve-exposure",
        score: pillars.backing.score,
        effectiveWeight: 1,
        weightedContribution: pillars.backing.score,
        observationState: "known",
      }],
    },
    exit: {
      evaluatedScore: pillars.exit.score,
      publishedScore: pillars.exit.score,
      aggregationWeight: 0.35,
      adjustments: [],
      stressRequest: {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        comparisonWindowSec: 86_400,
      },
      primaryRoute: {
        key: "redemption:reviewed",
        label: "Protocol redemption",
        routeFamily: "protocol-redemption",
        score: pillars.exit.score,
        components: EXIT_COMPONENTS.map(({ key, label, weight }) => ({
          key,
          label,
          score: pillars.exit.score!,
          weight,
          weightedContribution: pillars.exit.score! * weight,
        })),
        confidenceFactor: 1,
        eligibilityMultiplier: 1,
        capsApplied: [],
      },
      diversification: null,
      alternatives: [],
    },
    control: {
      evaluatedScore: pillars.control.score,
      publishedScore: pillars.control.score,
      aggregationWeight: 0.25,
      adjustments: [],
      method: "minimum-binding-component",
      components: [{
        key: "control:reviewed",
        label: "Reviewed control",
        kind: "mint",
        posture: "distributed",
        score: pillars.control.score,
        binding: true,
      }],
    },
  } satisfies V9Breakdowns;
}

/** Explicit three-pillar block for suites that assert on specific pillar scores. */
export function makeReportCardsV9Pillars(scores: {
  backing: number | null;
  exit: number | null;
  control: number | null;
}): SafetyScoreV9CurrentCard["pillars"] {
  const pillar = (score: number | null) => ({
    score,
    evidenceLevel: "adequate" as const,
    freshness: "current" as const,
    components: [...PILLAR_COMPONENTS],
    reasons: [],
  });
  return {
    backing: pillar(scores.backing),
    exit: pillar(scores.exit),
    control: pillar(scores.control),
  };
}

export function makeReportCardsV9Card(
  overrides: Partial<SafetyScoreV9CurrentCard> = {},
): SafetyScoreV9CurrentCard {
  const score = overrides.score === undefined ? DEFAULT_SCORE : overrides.score;
  const grade = overrides.grade ?? scoreToV9Grade(score);
  const reviewedPillarScores = overrides.pillars === undefined
    ? []
    : Object.values(overrides.pillars)
        .map((pillar) => pillar.score)
        .filter((pillarScore): pillarScore is number => pillarScore !== null);
  const qualityScore = overrides.qualityScore === undefined
    ? reviewedPillarScores.length > 0
      ? reviewedPillarScores.reduce((sum, pillarScore) => sum + pillarScore, 0) /
        reviewedPillarScores.length
      : DEFAULT_QUALITY_SCORE
    : overrides.qualityScore;
  const pegMultiplier =
    overrides.pegMultiplier === undefined ? DEFAULT_PEG_MULTIPLIER : overrides.pegMultiplier;
  const pegAdjustedScore =
    overrides.pegAdjustedScore === undefined ? score : overrides.pegAdjustedScore;
  const pillar = (pillarScore: number | null) => ({
    score: pillarScore,
    evidenceLevel: "adequate" as const,
    freshness: "current" as const,
    components: [...PILLAR_COMPONENTS],
    reasons: [],
  });
  const pillars = overrides.pillars ?? {
    backing: pillar(qualityScore === null ? null : Math.max(0, qualityScore - 2)),
    exit: pillar(qualityScore),
    control: pillar(qualityScore === null ? null : Math.min(100, qualityScore + 2)),
  };
  const weakest = (
    Object.entries(pillars) as Array<[V9PillarKey, (typeof pillars)["backing"]]>
  )
    .filter((entry) => entry[1].score !== null)
    .sort((left, right) => left[1].score! - right[1].score!)[0];
  const weakestPillar = overrides.weakestPillar !== undefined
    ? overrides.weakestPillar
    : qualityScore === null || weakest === undefined
      ? null
      : { pillar: weakest[0], score: weakest[1].score! };
  const breakdowns = overrides.breakdowns !== undefined
    ? overrides.breakdowns
    : buildBreakdowns(score, pillars);
  const card = {
    id: "usdc-circle",
    pegMultiplier,
    pegAdjustedScore,
    caps: [],
    bindingCap: null,
    nrReasons: [],
    reasonCodes: [],
    evidence: { level: "adequate" as const, freshness: "current" as const, reasons: [] },
    accessPosture: {
      transfer: "restrictable" as const,
      freezeExposure: "direct" as const,
      primaryExit: "eligibility-gated" as const,
      governance: "single-entity" as const,
      unknownFields: [],
      signals: [],
      reasons: [],
    },
    dependencies: { serial: [], basket: [], cycleBlocked: false as const, reasonCodes: [] },
    ...overrides,
    score,
    grade,
    qualityScore,
    pillars,
    weakestPillar,
    breakdowns,
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
        facts: [],
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

export function makeReportCardsV9Response(
  preset: ReportCardsV9ResponseFixturePreset,
  makeCard: () => SafetyScoreV9CurrentCard,
  overrides: Partial<ReportCardsV9Response> = {},
): ReportCardsV9Response {
  const cards = overrides.cards ?? [makeCard()];
  const safetyScoreIdentity = overrides.safetyScoreIdentity ?? {
    ...preset.safetyScoreIdentity,
  };
  const updatedAt = overrides.updatedAt ?? preset.defaultUpdatedAt;
  return {
    model: "v9",
    schemaVersion: 4,
    lifecycle: "active",
    safetyScoreIdentity,
    methodology: {
      version: safetyScoreIdentity.methodologyVersion,
      policy: { id: safetyScoreIdentity.policyId, semanticDigest: safetyScoreIdentity.policyDigest },
    },
    asOfSec: preset.asOfSec,
    updatedAt,
    publicationHealth: overrides.publicationHealth ?? {
      schemaVersion: 1,
      status: "current",
      acceptedPublicationGenerationId:
        safetyScoreIdentity.publicationGenerationId,
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
      ...preset.source,
      sourceGenerations: { ...preset.source.sourceGenerations },
    },
    cards,
    dependencyGraph: buildReportCardsV9DependencyGraph(cards),
    ...overrides,
  };
}
