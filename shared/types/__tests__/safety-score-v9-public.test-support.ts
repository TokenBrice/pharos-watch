import type { z } from "zod";
import type { SafetyScoreV9CurrentResponseSchema } from "../safety-score-v9-public";
import type { SafetyScoreV9BreakdownsSchema } from "../safety-score-v9-public-breakdowns";

type CurrentResponse = z.output<typeof SafetyScoreV9CurrentResponseSchema>;

const DIGEST = "a".repeat(64);

const EVIDENCE_RESPONSIBILITIES = [
  "integration-missing",
  "issuer-undisclosed",
  "measured-adverse",
  "method-unsupported",
  "producer-failed",
  "public-data-uncurated",
  "published-evidence-expired",
  "unresearched",
] as const;

function emptyAttribution<S extends string>(semantics: S) {
  return { semantics, items: [] as never[] };
}

function emptyEvidenceSummary<R extends string>(responsibility: R) {
  return { responsibility, factCount: 0, criticalFactCount: 0, reasonCodes: [] as never[] };
}

function includedPillar() {
  return { aggregationDisposition: "included" as const, supportedComponentKeys: ["fixture-known"], causeGapRefs: [], limitedEvidenceCauses: [] };
}
function includedBreakdown() {
  const { supportedComponentKeys: _supported, ...fields } = includedPillar();
  return fields;
}

function includedContribution(effectiveScoringWeight: number) {
  return { cause: null, causeGapRefs: [], scoringDisposition: "included" as const, effectiveScoringWeight };
}

function pillar(score: number): CurrentResponse["cards"][number]["pillars"]["backing"] {
  return {
    score,
    ...includedPillar(),
    evidenceLevel: "strong",
    freshness: "current",
    components: [],
    reasons: [],
  };
}

export function breakdowns(backingScore = 90, exitScore = 92, controlScore = 95.2): z.output<typeof SafetyScoreV9BreakdownsSchema> {
  const exitComponents = [
    ["access", "Access", 0.2],
    ["settlement", "Settlement", 0.15],
    ["executionCertainty", "Execution certainty", 0.15],
    ["capacity", "Capacity", 0.25],
    ["outputAssetQuality", "Output asset quality", 0.15],
    ["cost", "Cost", 0.1],
  ] as const;
  return {
    backing: {
      ...includedBreakdown(),
      evaluatedScore: backingScore,
      publishedScore: backingScore,
      aggregationWeight: 0.4,
      groups: [{ key: "reserves", label: "Reserves", score: backingScore, ...includedContribution(1) }],
      components: [{
        key: "reserve:cash",
        label: "Cash",
        source: "reserve-exposure",
        score: backingScore,
        ...includedContribution(1),
        wholeAssetWeight: 1,
        weightedContribution: backingScore,
        observationState: "known",
      }],
      adjustments: [],
    },
    exit: {
      ...includedBreakdown(),
      evaluatedScore: exitScore,
      publishedScore: exitScore,
      aggregationWeight: 0.35,
      stressRequest: {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        comparisonWindowSec: 86_400,
      },
      primaryRoute: {
        key: "redemption:main",
        routeId: "main",
        lane: "redemption",
        label: "Protocol redemption",
        routeFamily: "protocol-redemption",
        score: exitScore,
        components: exitComponents.map(([key, label, weight]) => ({
          key,
          label,
          score: exitScore,
          weight,
          ...includedContribution(weight),
          weightedContribution: exitScore * weight,
        })),
        confidenceFactor: 1,
        confidenceDimensions: {
          observation: { factor: 1, cause: null, causeGapRefs: [] },
          model: { factor: 1, cause: null, causeGapRefs: [] },
          capacityMethod: { factor: 1, cause: null, causeGapRefs: [] },
        },
        capacityEvidenceTier: "live-direct",
        rawSameNotionalCostBps: 0,
        supportedComponentCeiling: exitScore,
        eligibilityMultiplier: 1,
        capsApplied: [],
      },
      diversification: null,
      alternatives: [],
      adjustments: [],
    },
    control: {
      ...includedBreakdown(),
      evaluatedScore: controlScore,
      publishedScore: controlScore,
      aggregationWeight: 0.25,
      method: "minimum-binding-component",
      components: [{
        key: "control:mint",
        label: "Mint control",
        kind: "mint",
        score: controlScore,
        ...includedContribution(1),
        binding: true,
        posture: "distributed",
      }],
      adjustments: [],
    },
  };
}

function response() {
  return {
    model: "v9-critical-path",
    schemaVersion: 1,
    lifecycle: "candidate",
    candidateId: "candidate-v1",
    policyVersion: "candidate-v1",
    publicationGenerationId: "safety-score:v9:1",
    baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    factSetDigest: DIGEST,
    resultDigest: "c".repeat(64),
    policy: { id: "safety-score-v9-candidate-v1", semanticDigest: "d".repeat(64) },
    evaluationBuildDigest: "e".repeat(64),
    sourceGenerations: { dex: "dex:g1", registry: "registry:g1" },
    asOfSec: 100,
    publishedAtSec: 101,
    completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [], pipelineGapCount: 0, pipelineGapIds: [] },
    foreignCauseGaps: [],
    cards: [
      {
        id: "asset",
        localCauseGaps: [], foreignCauseGapRefs: [],
        score: 90,
        grade: "A+",
        ratingStatus: "rated",
        partialEvidence: null,
        qualityScore: 92,
        pegMultiplier: 1,
        pegAdjustedScore: 92,
        pillars: { backing: pillar(90), exit: pillar(92), control: pillar(95.2) },
        weakestPillar: { pillar: "backing", score: 90 },
        caps: [
          {
            kind: "bounded-compensability",
            limit: 98,
            source: "bounded-compensability",
            reason: "Weakest-pillar headroom.",
            binding: false,
          },
          { kind: "track-record", limit: 90, source: "track-record", reason: "Track record binds.", binding: true },
        ],
        bindingCap: {
          kind: "track-record",
          limit: 90,
          source: "track-record",
          reason: "Track record binds.",
          binding: true,
        },
        nrReasons: [],
        reasonCodes: [],
        evidence: { level: "strong", freshness: "current", reasons: [] },
        accessPosture: {
          transfer: "restrictable",
          freezeExposure: "direct",
          primaryExit: "eligibility-gated",
          governance: "single-entity",
          unknownFields: [],
          signals: [
            "freeze:direct",
            "governance:single-entity",
            "primary-exit:eligibility-gated",
            "transfer:restrictable",
          ],
          reasons: [],
        },
        dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
      },
    ],
  } as const;
}

export function currentResponse() {
  const current = response() as unknown as CurrentResponse;
  current.schemaVersion = 7;
  current.lifecycle = "active";
  current.policyVersion = "9.0";
  current.policy = { id: "safety-score-v9", semanticDigest: "d".repeat(64) };
  current.cards[0]!.scoreTrace = {
    schemaVersion: 4,
    legacyAliases: {
      qualityScore: "weighted-pillar-mean",
      pegAdjustedScore: "post-deployment-pre-cap-score",
      score: "post-cap-public-score",
    },
    aggregation: {
      method: "smooth-bounded-headroom",
      includedPillars: ["backing", "control", "exit"],
      excludedPillars: [],
      effectiveScoringWeights: { backing: 0.4, exit: 0.35, control: 0.25 },
      supportCeiling: 92,
      score: 92,
      weightedPillarMean: 92,
      weakestPillar: "backing",
      weakestScore: 90,
      headroom: 45,
    },
    stages: {
      weightedPillarMean: 92,
      aggregatedQualityScore: 92,
      pegMultiplier: 1,
      baseAssetScore: 92,
      deploymentAdjustedScore: 92,
      deploymentAdjustmentPoints: 0,
      preCapScore: 92,
      publishedScore: 90,
    },
    deploymentRisk: {
      method: "holder-slice-exposure-weighted-v2",
      totalAdjustmentPoints: 0,
      adjustments: [],
      unresolvedExposures: [],
    },
    adverseAttribution: emptyAttribution("causal-measured-adverse-v1"),
    boundedUncertaintyAttribution: emptyAttribution("causal-bounded-uncertainty-v1"),
    evidenceResponsibility: {
      semantics: "limiting-fact-cause-v2",
      totalFactCount: 0,
      facts: [],
      summaries: EVIDENCE_RESPONSIBILITIES.map(emptyEvidenceSummary),
    },
    scoreAdjustments: [],
    wrapperParentLimit: null,
  };
  current.cards[0]!.breakdowns = breakdowns();
  return current;
}

export function adjustedResponse() {
  const adjusted = currentResponse();
  const card = adjusted.cards[0]!;
  const structuralCap: CurrentResponse["cards"][number]["caps"][number] = {
    kind: "signal:centralized-mint:low",
    limit: 94,
    source: "structural",
    reason: "The premium relieves only the named low-severity structural cap.",
    binding: true,
  };
  card.score = 94;
  card.grade = "A+";
  card.pegAdjustedScore = 96;
  card.caps = [
    { ...card.caps[0]!, binding: false },
    structuralCap,
  ];
  card.bindingCap = structuralCap;
  card.scoreTrace.stages.preCapScore = 96;
  card.scoreTrace.stages.publishedScore = 94;
  card.scoreTrace.scoreAdjustments = [{
    source: "asset-premium",
    kind: "market-anchor-longevity",
    label: "#1 & Longevity Premium",
    configuredPoints: 4,
    appliedPoints: 4,
    scoreBefore: 92,
    scoreAfter: 96,
    publishedScoreBefore: 83,
    publishedScoreAfter: 94,
    capRelief: {
      source: "structural",
      kind: "signal:centralized-mint:low",
      fromLimit: 83,
      toLimit: 94,
    },
  }];
  return adjusted;
}

export function boundedResponse() {
  const bounded = currentResponse();
  bounded.cards[0]!.localCauseGaps = ["mechanism"];
  bounded.cards[0]!.score = 45;
  bounded.cards[0]!.grade = "D";
  bounded.cards[0]!.qualityScore = 45;
  bounded.cards[0]!.pegAdjustedScore = 45;
  bounded.cards[0]!.pillars = {
    backing: {
      ...includedPillar(),
      causeGapRefs: [0],
      limitedEvidenceCauses: ["U"],
      score: 45,
      evidenceLevel: "limited",
      freshness: "current",
      components: [],
      reasons: [{
        code: "bounded-mechanism-review",
        path: "backing:mechanism",
        message: "A bounded backing review remains unresolved.",
      }],
    },
    exit: { ...pillar(45), components: [], reasons: [] },
    control: { ...pillar(45), components: [], reasons: [] },
  };
  bounded.cards[0]!.breakdowns = breakdowns(45, 45, 45);
  bounded.cards[0]!.weakestPillar = { pillar: "backing", score: 45 };
  bounded.cards[0]!.caps = bounded.cards[0]!.caps.map((cap) => ({ ...cap, binding: false }));
  bounded.cards[0]!.bindingCap = null;
  bounded.cards[0]!.reasonCodes = ["bounded-mechanism-review"];
  bounded.cards[0]!.scoreTrace.aggregation = {
    method: "smooth-bounded-headroom",
    includedPillars: ["backing", "control", "exit"], excludedPillars: [],
    effectiveScoringWeights: { backing: 0.4, exit: 0.35, control: 0.25 }, supportCeiling: 45,
    score: 45,
    weightedPillarMean: 45,
    weakestPillar: "backing",
    weakestScore: 45,
    headroom: 45,
  };
  Object.assign(bounded.cards[0]!.scoreTrace.stages, {
    weightedPillarMean: 45,
    aggregatedQualityScore: 45,
    baseAssetScore: 45,
    deploymentAdjustedScore: 45,
    preCapScore: 45,
    publishedScore: 45,
  });
  bounded.cards[0]!.scoreTrace.boundedUncertaintyAttribution.items = [{
    source: "reason",
    code: "bounded-mechanism-review",
    path: "backing:mechanism",
    message: "A bounded backing review remains unresolved.",
    responsibility: "unresearched",
    cause: "U",
    causeGapRefs: [0],
  }];
  bounded.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount = 1;
  bounded.cards[0]!.scoreTrace.evidenceResponsibility.facts = [[
    "bounded-mechanism-review", "backing:mechanism", 0, "unresearched", false, "U", [0],
  ]];
  bounded.cards[0]!.scoreTrace.evidenceResponsibility.summaries[7] = {
    responsibility: "unresearched",
    factCount: 1,
    criticalFactCount: 0,
    reasonCodes: ["bounded-mechanism-review"],
  };
  return bounded;
}

export function deploymentResponse() {
  const result = currentResponse();
  const card = result.cards[0]!;
  card.pegAdjustedScore = 90;
  Object.assign(card.scoreTrace.stages, {
    deploymentAdjustedScore: 90,
    deploymentAdjustmentPoints: 2,
    preCapScore: 90,
  });
  card.scoreTrace.deploymentRisk.totalAdjustmentPoints = 2;
  card.scoreTrace.deploymentRisk.adjustments = ["a", "b"].map((key, index) => ({
    signalKey: key,
    sourceSignalKeys: [key],
    exposureKey: key,
    riskEventKey: `event:${key}`,
    failureDomainKey: `domain:${key}`,
    nominalExposureShare: 0.5,
    exposureShare: 0.5,
    exposedScore: 90,
    scoreBefore: 92 - index,
    scoreAfter: 91 - index,
    adjustmentPoints: 1,
    modeledLossPoints: 1,
    reason: "Measured deployment exposure.",
  }));
  return result;
}

export function partialResponse(excluded: readonly ("backing" | "exit" | "control")[]) {
  const result = currentResponse();
  const card = result.cards[0]!;
  const pillars = ["backing", "control", "exit"] as const;
  const excludedPillars = [...excluded].sort();
  card.localCauseGaps = excludedPillars;
  const included = pillars.filter((key) => !excluded.includes(key));
  const pipeline = included.length < 2;
  const weights = { backing: 0.4, exit: 0.35, control: 0.25 };
  const totalWeight = included.reduce((sum, key) => sum + weights[key], 0);
  for (const key of pillars) {
    card.breakdowns![key].aggregationWeight = pipeline || excluded.includes(key) ? 0 : weights[key] / totalWeight;
    if (!excluded.includes(key)) continue;
    const cause = key === "exit" ? "B" as const : "A" as const;
    const gapRef = excludedPillars.indexOf(key);
    const disposition = cause === "A" ? "excluded-pipeline" as const : "excluded-uncurated" as const;
    const diagnostic = { cause, causeGapRefs: [gapRef], scoringDisposition: disposition, effectiveScoringWeight: 0, score: null };
    Object.assign(card.pillars[key], {
      score: null, aggregationDisposition: "excluded-a-b", supportedComponentKeys: [],
      causeGapRefs: [gapRef], limitedEvidenceCauses: [],
    });
    Object.assign(card.breakdowns![key], {
      evaluatedScore: null, publishedScore: null, aggregationDisposition: "excluded-a-b",
      causeGapRefs: [gapRef], limitedEvidenceCauses: [], adjustments: [],
    });
    if (key === "backing") {
      for (const row of card.breakdowns!.backing.groups) Object.assign(row, diagnostic);
      for (const row of card.breakdowns!.backing.components) Object.assign(row, diagnostic, { weightedContribution: 0, observationState: "missing" });
    } else if (key === "exit") {
      const route = card.breakdowns!.exit.primaryRoute!;
      route.score = null; route.supportedComponentCeiling = null; route.rawSameNotionalCostBps = null;
      for (const row of route.components) Object.assign(row, diagnostic, { weightedContribution: 0 });
      for (const dimension of Object.values(route.confidenceDimensions)) Object.assign(dimension, { factor: 1, cause, causeGapRefs: [gapRef] });
    } else {
      for (const row of card.breakdowns!.control.components) Object.assign(row, diagnostic, { binding: false });
    }
  }
  if (excluded.length > 0) {
    card.partialEvidence = {
      reasonCode: "partial-evidence-pipeline-gap", excludedPillars,
      excludedComponentKeys: excludedPillars.map((key) => `${key}:fixture-known`),
      causeGapRefs: excludedPillars.map((_, index) => index),
      causes: excluded.includes("exit") && excluded.length > 1 ? ["A", "B"] : excluded.includes("exit") ? ["B"] : ["A"],
    };
    card.reasonCodes = ["partial-evidence-pipeline-gap"];
  }
  if (pipeline) {
    Object.assign(card, { ratingStatus: "pipeline-gap", score: null, grade: null, qualityScore: null,
      pegMultiplier: null, pegAdjustedScore: null, weakestPillar: null, bindingCap: null });
    for (const cap of card.caps) cap.binding = false;
    card.reasonCodes = [excluded.length === 3 ? "all-pillars-pipeline-gap" : "single-pillar-pipeline-gap", "partial-evidence-pipeline-gap"].sort() as typeof card.reasonCodes;
    card.scoreTrace.aggregation = null;
    for (const field of Object.keys(card.scoreTrace.stages) as (keyof typeof card.scoreTrace.stages)[]) card.scoreTrace.stages[field] = null;
    card.scoreTrace.deploymentRisk.totalAdjustmentPoints = null;
    Object.assign(result.completeness, { ratedCount: 0, pipelineGapCount: 1, pipelineGapIds: [card.id] });
  } else if (excluded.length > 0) {
    const effectiveScoringWeights = { backing: 0, exit: 0, control: 0 };
    for (const key of included) effectiveScoringWeights[key] = weights[key] / totalWeight;
    const mean = included.reduce((sum, key) => sum + card.pillars[key].score! * effectiveScoringWeights[key], 0);
    const weakest = included.reduce((left, right) => card.pillars[left].score! <= card.pillars[right].score! ? left : right);
    card.qualityScore = mean; card.pegAdjustedScore = mean;
    card.weakestPillar = { pillar: weakest, score: card.pillars[weakest].score! };
    Object.assign(card.scoreTrace.aggregation!, {
      score: mean, weightedPillarMean: mean, supportCeiling: mean, includedPillars: included,
      excludedPillars, effectiveScoringWeights, weakestPillar: weakest, weakestScore: card.pillars[weakest].score,
    });
    Object.assign(card.scoreTrace.stages, { weightedPillarMean: mean, aggregatedQualityScore: mean,
      baseAssetScore: mean, deploymentAdjustedScore: mean, preCapScore: mean });
  }
  return result;
}
