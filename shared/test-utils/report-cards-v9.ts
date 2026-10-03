import {
  buildReportCardsV9DependencyGraph,
  REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
  type ReportCardsV9Response,
} from "@shared/types/report-cards-v9";
import { V9EvidenceResponsibilitySchema } from "@shared/types/safety-score-v9-fact-primitives";
import { scoreToGrade, V9_PILLAR_WEIGHTS } from "@shared/types/safety-score-v9-grade";
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
  exclusionCause: "A" | "B" = "A",
): V9Breakdowns | null {
  const included = (Object.keys(pillars) as V9PillarKey[]).filter((key) => pillars[key].aggregationDisposition === "included");
  const totalWeight = included.reduce((sum, key) => sum + V9_PILLAR_WEIGHTS[key], 0);
  const base = (key: V9PillarKey) => ({
    aggregationDisposition: pillars[key].aggregationDisposition,
    causeGapRefs: pillars[key].causeGapRefs,
    limitedEvidenceCauses: pillars[key].limitedEvidenceCauses,
    aggregationWeight: score === null || !included.includes(key) ? 0 : V9_PILLAR_WEIGHTS[key] / totalWeight,
  });
  const contribution = (key: V9PillarKey, weight = 1) => ({
    cause: pillars[key].aggregationDisposition === "excluded-a-b" ? exclusionCause : null,
    causeGapRefs: pillars[key].causeGapRefs,
    scoringDisposition: pillars[key].aggregationDisposition === "excluded-a-b"
      ? exclusionCause === "A" ? "excluded-pipeline" as const : "excluded-uncurated" as const
      : "included" as const,
    effectiveScoringWeight: pillars[key].aggregationDisposition === "excluded-a-b" ? 0 : weight,
  });

  return {
    backing: {
      evaluatedScore: pillars.backing.score,
      publishedScore: pillars.backing.score,
      ...base("backing"),
      adjustments: [],
      groups: [{
        key: "reserves",
        label: "Reserves",
        score: pillars.backing.score,
        ...contribution("backing"),
      }],
      components: [{
        key: "reserve:reviewed",
        label: "Reviewed reserves",
        source: "reserve-exposure",
        score: pillars.backing.score,
        ...contribution("backing"),
        wholeAssetWeight: 1,
        weightedContribution: pillars.backing.score ?? 0,
        observationState: "known",
      }],
    },
    exit: {
      evaluatedScore: pillars.exit.score,
      publishedScore: pillars.exit.score,
      ...base("exit"),
      adjustments: [],
      stressRequest: {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        comparisonWindowSec: 86_400,
      },
      primaryRoute: pillars.exit.score === null ? null : {
        key: "redemption:reviewed",
        label: "Protocol redemption",
        routeFamily: "protocol-redemption",
        score: pillars.exit.score,
        components: EXIT_COMPONENTS.map(({ key, label, weight }) => ({
          key,
          label,
          score: pillars.exit.score!,
          weight,
          ...contribution("exit", weight),
          weightedContribution: pillars.exit.score! * weight,
        })),
        confidenceFactor: 1,
        confidenceDimensions: {
          observation: { factor: 1, cause: null, causeGapRefs: [] },
          model: { factor: 1, cause: null, causeGapRefs: [] },
          capacityMethod: { factor: 1, cause: null, causeGapRefs: [] },
        },
        capacityEvidenceTier: "live-direct",
        rawSameNotionalCostBps: 0,
        supportedComponentCeiling: pillars.exit.score,
        eligibilityMultiplier: 1,
        capsApplied: [],
      },
      diversification: null,
      alternatives: [],
    },
    control: {
      evaluatedScore: pillars.control.score,
      publishedScore: pillars.control.score,
      ...base("control"),
      adjustments: [],
      method: "minimum-binding-component",
      components: [{
        key: "control:reviewed",
        label: "Reviewed control",
        kind: "mint",
        posture: "distributed",
        score: pillars.control.score,
        binding: pillars.control.score !== null,
        ...contribution("control"),
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
    aggregationDisposition: "included" as const,
    supportedComponentKeys: score === null ? [] : [...PILLAR_COMPONENTS],
    causeGapRefs: [],
    limitedEvidenceCauses: [],
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
  const ratingStatus = overrides.ratingStatus ?? (score === null ? "not-rated" : "rated");
  const grade = overrides.grade !== undefined ? overrides.grade : ratingStatus === "pipeline-gap" ? null : scoreToGrade(score);
  const initialQuality = overrides.qualityScore === undefined ? DEFAULT_QUALITY_SCORE : overrides.qualityScore;
  const pegMultiplier =
    ratingStatus === "pipeline-gap" ? null : overrides.pegMultiplier === undefined ? DEFAULT_PEG_MULTIPLIER : overrides.pegMultiplier;
  const pegAdjustedScore =
    ratingStatus === "pipeline-gap" ? null : overrides.pegAdjustedScore === undefined ? score : overrides.pegAdjustedScore;
  const pillars = overrides.pillars ?? makeReportCardsV9Pillars({
    backing: initialQuality === null ? null : Math.max(0, initialQuality - 2),
    exit: initialQuality,
    control: initialQuality === null ? null : Math.min(100, initialQuality + 2),
  });
  const includedPillars = (Object.keys(pillars) as V9PillarKey[]).filter((key) => pillars[key].aggregationDisposition === "included").sort();
  const excludedPillars = (Object.keys(pillars) as V9PillarKey[]).filter((key) => pillars[key].aggregationDisposition === "excluded-a-b").sort();
  const weightSum = includedPillars.reduce((sum, key) => sum + V9_PILLAR_WEIGHTS[key], 0);
  const effectiveScoringWeights = Object.fromEntries((Object.keys(pillars) as V9PillarKey[]).map((key) => [
    key, includedPillars.includes(key) && weightSum > 0 ? V9_PILLAR_WEIGHTS[key] / weightSum : 0,
  ])) as Record<V9PillarKey, number>;
  const qualityScore = ratingStatus !== "rated" || initialQuality === null ? null
    : includedPillars.reduce((sum, key) => sum + (pillars[key].score ?? 0) * effectiveScoringWeights[key], 0);
  const weakest = (
    Object.entries(pillars) as Array<[V9PillarKey, (typeof pillars)["backing"]]>
  )
    .filter((entry) => entry[1].score !== null)
    .sort((left, right) => left[1].score! - right[1].score!)[0];
  const weakestPillar = overrides.weakestPillar !== undefined
    ? overrides.weakestPillar
    : ratingStatus === "pipeline-gap" || qualityScore === null || weakest === undefined
      ? null
      : { pillar: weakest[0], score: weakest[1].score! };
  const breakdowns = overrides.breakdowns !== undefined
    ? overrides.breakdowns
    : ratingStatus === "not-rated" ? null : buildBreakdowns(score, pillars, overrides.partialEvidence?.causes[0]);
  const card = {
    id: "usdc-circle",
    localCauseGaps: [],
    foreignCauseGapRefs: [],
    ratingStatus,
    partialEvidence: null,
    supply: { circulatingUsdAtEvaluation: null, asOfSec: null, generationId: null },
    sharedBookId: null,
    dependencyCoverage: [],
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
      schemaVersion: 4,
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
            includedPillars,
            excludedPillars,
            effectiveScoringWeights,
            supportCeiling: card.qualityScore!,
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
        semantics: "limiting-fact-cause-v2",
        totalFactCount: 0,
        facts: [],
        summaries: [...V9EvidenceResponsibilitySchema.options]
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
          .map((responsibility) => ({
            responsibility,
            factCount: 0,
            criticalFactCount: 0,
            reasonCodes: [],
          })),
      },
      scoreAdjustments: [],
      wrapperParentLimit: null,
    },
  };
}

/** Cause-proven excluded pillars retain their measured siblings without inventing a grade. */
export function makeReportCardsV9PartialCard(
  excludedPillar: V9PillarKey = "exit",
  cause: "A" | "B" = "A",
  overrides: Partial<SafetyScoreV9CurrentCard> = {},
): SafetyScoreV9CurrentCard {
  const pillars = makeReportCardsV9Pillars({ backing: 80, exit: 80, control: 80 });
  pillars[excludedPillar] = { ...pillars[excludedPillar], score: null, aggregationDisposition: "excluded-a-b",
    supportedComponentKeys: [], causeGapRefs: [0], limitedEvidenceCauses: [] };
  return makeReportCardsV9Card({
    score: 80, pegMultiplier: 1, pillars,
    localCauseGaps: [excludedPillar],
    partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [excludedPillar],
      excludedComponentKeys: [`${excludedPillar}:reviewed`], causeGapRefs: [0], causes: [cause] },
    ...overrides,
  });
}

/** One or zero included pillars is technical unavailability, not NR. */
export function makeReportCardsV9PipelineGapCard(
  survivingPillar: V9PillarKey | null = "control",
  cause: "A" | "B" = "A",
  overrides: Partial<SafetyScoreV9CurrentCard> = {},
): SafetyScoreV9CurrentCard {
  const pillars = makeReportCardsV9Pillars({ backing: 80, exit: 80, control: 80 });
  const excludedPillars = (Object.keys(pillars) as V9PillarKey[]).filter((key) => key !== survivingPillar).sort();
  for (let ref = 0; ref < excludedPillars.length; ref++) {
    const key = excludedPillars[ref]!;
    pillars[key] = { ...pillars[key], score: null, aggregationDisposition: "excluded-a-b",
      supportedComponentKeys: [], causeGapRefs: [ref], limitedEvidenceCauses: [] };
  }
  return makeReportCardsV9Card({
    ratingStatus: "pipeline-gap", score: null, grade: null, pillars,
    localCauseGaps: excludedPillars,
    reasonCodes: [survivingPillar === null ? "all-pillars-pipeline-gap" : "single-pillar-pipeline-gap"],
    partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars,
      excludedComponentKeys: excludedPillars.map((key) => `${key}:reviewed`),
      causeGapRefs: excludedPillars.map((_, ref) => ref), causes: [cause] },
    ...overrides,
  });
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
    schemaVersion: REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
    lifecycle: "active",
    safetyScoreIdentity,
    methodology: {
      version: safetyScoreIdentity.methodologyVersion,
      policy: { id: safetyScoreIdentity.policyId, semanticDigest: safetyScoreIdentity.policyDigest },
    },
    asOfSec: preset.asOfSec,
    updatedAt,
    publicationHealth: overrides.publicationHealth ?? {
      schemaVersion: 2,
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
      ratedCount: cards.filter((card) => card.ratingStatus === "rated").length,
      notRatedCount: cards.filter((card) => card.grade === "NR").length,
      notRatedIds: cards.filter((card) => card.grade === "NR").map((card) => card.id).sort(),
      pipelineGapCount: cards.filter((card) => card.ratingStatus === "pipeline-gap").length,
      pipelineGapIds: cards.filter((card) => card.ratingStatus === "pipeline-gap").map((card) => card.id).sort(),
    },
    source: {
      ...preset.source,
      sourceGenerations: { ...preset.source.sourceGenerations },
    },
    cards,
    foreignCauseGaps: [],
    dependencyGraph: buildReportCardsV9DependencyGraph(cards),
    commonModeGroups: [],
    ...overrides,
  };
}
