import type { z } from "zod";
import type { SafetyScoreV9CurrentResponseSchema, SafetyScoreV9BreakdownsSchema } from "../safety-score-v9-public";

type CurrentResponse = z.input<typeof SafetyScoreV9CurrentResponseSchema>;

const DIGEST = "a".repeat(64);

function pillar(score: number): CurrentResponse["cards"][number]["pillars"]["backing"] {
  return {
    score,
    evidenceLevel: "strong",
    freshness: "current",
    components: [],
    reasons: [],
  };
}

export function breakdowns(backingScore = 90, exitScore = 92, controlScore = 94): z.input<typeof SafetyScoreV9BreakdownsSchema> {
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
      evaluatedScore: backingScore,
      publishedScore: backingScore,
      aggregationWeight: 0.4,
      groups: [{ key: "reserves", label: "Reserves", score: backingScore, effectiveWeight: 1 }],
      components: [{
        key: "reserve:cash",
        label: "Cash",
        source: "reserve-exposure",
        score: backingScore,
        effectiveWeight: 1,
        weightedContribution: backingScore,
        observationState: "known",
      }],
      adjustments: [],
    },
    exit: {
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
        label: "Protocol redemption",
        routeFamily: "protocol-redemption",
        score: exitScore,
        components: exitComponents.map(([key, label, weight]) => ({
          key,
          label,
          score: exitScore,
          weight,
          weightedContribution: exitScore * weight,
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
      evaluatedScore: controlScore,
      publishedScore: controlScore,
      aggregationWeight: 0.25,
      method: "minimum-binding-component",
      components: [{
        key: "control:mint",
        label: "Mint control",
        kind: "mint",
        score: controlScore,
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
    completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [] },
    cards: [
      {
        id: "asset",
        score: 90,
        grade: "A+",
        qualityScore: 92,
        pegMultiplier: 1,
        pegAdjustedScore: 92,
        pillars: { backing: pillar(90), exit: pillar(92), control: pillar(94) },
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
  current.schemaVersion = 5;
  current.lifecycle = "active";
  current.policyVersion = "9.0";
  current.policy = { id: "safety-score-v9", semanticDigest: "d".repeat(64) };
  current.cards[0]!.scoreTrace = {
    schemaVersion: 3,
    legacyAliases: {
      qualityScore: "weighted-pillar-mean",
      pegAdjustedScore: "post-deployment-pre-cap-score",
      score: "post-cap-public-score",
    },
    aggregation: {
      method: "smooth-bounded-headroom",
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
        { responsibility: "published-evidence-expired", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
      ],
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
  bounded.cards[0]!.score = 45;
  bounded.cards[0]!.grade = "D";
  bounded.cards[0]!.qualityScore = 45;
  bounded.cards[0]!.pegAdjustedScore = 45;
  bounded.cards[0]!.pillars = {
    backing: {
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
    responsibility: "integration-missing",
  }];
  bounded.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount = 1;
  bounded.cards[0]!.scoreTrace.evidenceResponsibility.summaries[0] = {
    responsibility: "integration-missing",
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
