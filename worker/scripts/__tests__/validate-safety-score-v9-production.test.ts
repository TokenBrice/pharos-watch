import { describe, expect, it } from "vitest";
import {
  evaluateV9ProductionAcceptance,
  toV9ProductionSupplyCents,
} from "../../../shared/lib/safety-score-v9/production-validation";
import {
  V9_PRODUCTION_REQUIRED_MONOTONIC_CONTROL_IDS,
  V9_PRODUCTION_REQUIRED_QUALITATIVE_SENTINEL_IDS,
  type V9ProductionSupplementalValidationEvidence,
  type V9ProductionV8MovementClassificationEvidence,
} from "../../../shared/types/safety-score-v9-production-validation";
import type { V9EvidenceResponsibility } from "../../../shared/types/safety-score-v9-fact-primitives";
import type { V9Grade, V9ReasonCode } from "../../../shared/types/safety-score-v9";
import {
  runV9ProductionValidationCli,
  type V9ProductionValidationIo,
} from "../validate-safety-score-v9-production";

interface CardSpec {
  id: string;
  score: number | null;
  grade: V9Grade;
  supplyUsd?: unknown;
  syntheticEvidenceFloor?: boolean;
  scoreInputTrackRecordMonths?: number;
  scoreInputReason?: {
    code: V9ReasonCode;
    responsibility: V9EvidenceResponsibility;
  };
}

const IDENTITY = {
  schemaVersion: 1 as const,
  policyId: "safety-score-v9-candidate-v2",
  policyDigest: "a".repeat(64),
  evaluationBuildDigest: "b".repeat(64),
  compilerFactSchemaDigest: "c".repeat(64),
  producerCapabilityDigest: "d".repeat(64),
};

const SOURCE_RECEIPT = {
  sourceCommit: "a".repeat(40),
  branch: "main",
  runtimeVersion: "v24.16.0",
  expectedRuntimeVersion: "v24.16.0",
  trackedWorktreeClean: true,
  validatedAtSec: 200_000,
} as const;

const PASSING_SPECS: CardSpec[] = [
  { id: "asset-01", score: 79, grade: "B+" },
  { id: "asset-02", score: 78, grade: "B+" },
  { id: "asset-03", score: 77, grade: "B+" },
  { id: "asset-04", score: 76, grade: "B+" },
  { id: "asset-05", score: 75, grade: "B+" },
  { id: "asset-06", score: 74, grade: "B" },
  { id: "asset-07", score: 73, grade: "B" },
  { id: "asset-08", score: 72, grade: "B" },
  { id: "asset-09", score: 71, grade: "B" },
  { id: "asset-10", score: 70, grade: "B" },
  { id: "asset-11", score: 64, grade: "C+" },
  { id: "asset-12", score: 63, grade: "C+" },
  { id: "asset-13", score: 62, grade: "C+" },
  { id: "asset-14", score: 59, grade: "C" },
  { id: "asset-15", score: 58, grade: "C" },
  { id: "asset-16", score: 57, grade: "C" },
  { id: "asset-17", score: 54.5, grade: "C-" },
  { id: "asset-18", score: 35, grade: "F" },
  { id: "bold-liquity", score: 86, grade: "A" },
  { id: "dai-makerdao", score: 74.5, grade: "B" },
  { id: "eurs-stasis", score: 28, grade: "F" },
  { id: "mim-abracadabra", score: 25, grade: "F" },
  { id: "sbold-k3-capital", score: 72.5, grade: "B" },
  { id: "sdai-makerdao", score: 70.5, grade: "B" },
  { id: "tusd-trueusd", score: 54, grade: "C-" },
  { id: "u-united-stables", score: 32, grade: "F" },
  { id: "usdc-circle", score: 85, grade: "A" },
  { id: "usdt-tether", score: 82, grade: "A-" },
  { id: "xaut-tether", score: 80, grade: "A-" },
];

function scoreTrace(spec: CardSpec) {
  const rated = spec.grade !== "NR";
  const score = rated ? spec.score : null;
  const adverse =
    spec.grade === "D" || spec.grade === "F"
      ? [{
          source: "pillar-score" as const,
          path: "pillars.backing",
          message: "Fixture measured-adverse pillar attribution.",
          responsibility: "measured-adverse" as const,
        }]
      : [];
  return {
    schemaVersion: 1 as const,
    legacyAliases: {
      qualityScore: "weighted-pillar-mean" as const,
      pegAdjustedScore: "post-deployment-pre-cap-score" as const,
      score: "post-cap-public-score" as const,
    },
    aggregation: rated
      ? {
          method: "smooth-bounded-headroom" as const,
          score: score!,
          weightedPillarMean: score!,
          weakestPillar: "backing" as const,
          weakestScore: score!,
          headroom: 45,
        }
      : null,
    stages: {
      weightedPillarMean: score,
      aggregatedQualityScore: score,
      pegMultiplier: rated ? 1 : null,
      baseAssetScore: score,
      deploymentAdjustedScore: score,
      deploymentAdjustmentPoints: rated ? 0 : null,
      preCapScore: score,
      publishedScore: score,
    },
    deploymentRisk: {
      method: "holder-slice-exposure-weighted-v2" as const,
      totalAdjustmentPoints: rated ? 0 : null,
      adjustments: [],
      unresolvedExposures: [],
    },
    wrapperParentLimit: null,
    adverseAttribution: {
      semantics: "causal-measured-adverse-v1" as const,
      items: adverse,
    },
    evidenceResponsibility: {
      semantics: "limiting-fact-owner-v1" as const,
      totalFactCount: 0,
      summaries: [
        "integration-missing",
        "issuer-undisclosed",
        "measured-adverse",
        "method-unsupported",
        "producer-failed",
      ].map((responsibility) => ({
        responsibility,
        factCount: 0,
        criticalFactCount: 0,
        reasonCodes: [],
      })),
    },
  };
}

function card(spec: CardSpec) {
  const evidenceFloor = spec.syntheticEvidenceFloor
    ? {
        kind: "evidence-floor:d",
        limit: 40,
        source: "evidence" as const,
        reason: "Synthetic evidence floor fixture.",
        binding: true,
      }
    : null;
  const rated = spec.grade !== "NR";
  return {
    id: spec.id,
    score: spec.score,
    grade: spec.grade,
    qualityScore: rated ? spec.score : null,
    pegMultiplier: rated ? 1 : null,
    pegAdjustedScore: rated ? spec.score : null,
    pillars: {
      backing: {
        score: rated ? spec.score : null,
        evidenceLevel: rated ? ("strong" as const) : ("insufficient" as const),
        freshness: "current" as const,
        components: [],
        reasons: [],
      },
      exit: {
        score: rated ? spec.score : null,
        evidenceLevel: rated ? ("strong" as const) : ("insufficient" as const),
        freshness: "current" as const,
        components: [],
        reasons: [],
      },
      control: {
        score: rated ? spec.score : null,
        evidenceLevel: rated ? ("strong" as const) : ("insufficient" as const),
        freshness: "current" as const,
        components: [],
        reasons: [],
      },
    },
    weakestPillar: rated ? { pillar: "backing" as const, score: spec.score } : null,
    caps: evidenceFloor === null ? [] : [evidenceFloor],
    bindingCap: evidenceFloor,
    nrReasons: rated
      ? []
      : [
          {
            code: "missing-pillar" as const,
            message: "Fixture is not rateable.",
            field: "backing",
            origin: "asset" as const,
          },
        ],
    reasonCodes: rated ? [] : (["missing-pillar"] as const),
    evidence: {
      level: rated ? ("strong" as const) : ("insufficient" as const),
      freshness: "current" as const,
      reasons: [],
    },
    accessPosture: {
      transfer: "permissionless" as const,
      freezeExposure: "none-known" as const,
      primaryExit: "permissionless" as const,
      governance: "distributed" as const,
      unknownFields: [],
      signals: [],
      reasons: [],
    },
    dependencies: {
      serial: [],
      basket: [],
      cycleBlocked: false,
      reasonCodes: [],
    },
    stressStateDigest: "e".repeat(64),
    scoreTrace: scoreTrace(spec),
  };
}

function scoreInput(spec: CardSpec) {
  const reason = spec.scoreInputReason
    ? [{
        code: spec.scoreInputReason.code,
        path: "exit.routes.primary",
        message: "Fixture score-bearing reason.",
        responsibility: spec.scoreInputReason.responsibility,
      }]
    : [];
  const pillar = {
    score: spec.score,
    evidenceLevel: spec.grade === "NR" ? "insufficient" : "strong",
    reasons: [],
    structuralSignals: [],
  };
  return {
    identity: { sourceGeneration: "ignored-by-semantic-projection" },
    pillars: {
      backing: pillar,
      exit: { ...pillar, reasons: reason },
      control: pillar,
    },
    peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
    parent: { required: false, score: null, propagatedReasons: [] },
    trackRecordMonths: spec.scoreInputTrackRecordMonths ?? 48,
    dependencyReasons: [],
    methodologyReasons: [],
    dependencyStructuralSignals: [],
  };
}

function roleDependencyInputs(
  inheritedScore: number,
  limit: number,
  options: {
    exposureKey?: string;
    riskEventKey?: string;
    eventExposureKey?: string;
    eventRiskEventKey?: string;
    nominalExposureShare?: number;
    exposureShare?: number;
  } = {},
) {
  const exposureKey = options.exposureKey ?? "exit:role-upstream";
  const riskEventKey =
    options.riskEventKey ?? "dependency-event:protocol:role-upstream";
  const eventExposureKey = options.eventExposureKey ?? exposureKey;
  const eventRiskEventKey = options.eventRiskEventKey ?? riskEventKey;
  const nominalExposureShare = options.nominalExposureShare ?? 0.25;
  const exposureShare = options.exposureShare ?? 0.25;
  const emptyProjection = {
    targetPillar: "control",
    limit: null,
    knownLossPoints: 0,
    boundedUnknownLossPoints: 0,
    unresolvedExposureShare: 0,
    materialUnresolvedExposure: false,
    events: [],
  };
  return {
    assetId: "usdc-circle",
    serial: [],
    basket: [],
    roleInputs: [{
      assetId: "usdc-circle",
      upstreamAssetId: "role-upstream",
      edgeKey: "exit-dependency:role-upstream",
      exposureKey,
      riskEventKey,
      dependencyType: "mechanism",
      role: "exit-dependency",
      weight: 0.25,
      inheritedDimensions: ["access", "exit"],
      unavailableDimensions: [],
      score: inheritedScore,
      boundedUnknown: false,
      cycleBlocked: false,
      evidenceRefIds: ["fixture:role-upstream"],
      failureDomains: [{ kind: "protocol", key: "role-upstream" }],
    }],
    rolePillarProjections: {
      exit: {
        targetPillar: "exit",
        limit,
        knownLossPoints: 100 - limit,
        boundedUnknownLossPoints: 0,
        unresolvedExposureShare: 0,
        materialUnresolvedExposure: false,
        events: [{
          targetPillar: "exit",
          exposureKey: eventExposureKey,
          riskEventKey: eventRiskEventKey,
          roles: ["exit-dependency"],
          edgeKeys: ["exit-dependency:role-upstream"],
          upstreamAssetIds: ["role-upstream"],
          nominalExposureShare,
          exposureShare,
          inheritedScore,
          modeledLossPoints: 100 - limit,
          boundedUnknown: false,
          cycleBlocked: false,
          unavailableDimensions: [],
          evidenceRefIds: ["fixture:role-upstream"],
          failureDomains: [{ kind: "protocol", key: "role-upstream" }],
        }],
      },
      control: emptyProjection,
    },
    cycleBlocked: false,
  };
}

function generation(index: number, specs: readonly CardSpec[] = PASSING_SPECS) {
  const character = String(index);
  const baseInputGenerationId = `report-cards-input:v1:${character.repeat(64)}`;
  const sourceGeneration = `report-cards:8.17:${1_000 + index}`;
  const clockSec = 1_000 + (index - 1) * 86_400;
  const sourceGenerations = { registry: `registry:g${index}` };
  const orderedSpecs = [...specs].sort((left, right) => left.id.localeCompare(right.id));
  const cards = orderedSpecs.map(card);
  const assetIds = orderedSpecs.map((spec) => spec.id);
  const factSetDigest = (index + 3).toString(16).repeat(64);
  const resultDigest = (index + 6).toString(16).repeat(64);
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-candidate-replay",
    pipeline: {
      fixedInput: {
        activeAssetIds: assetIds,
        sourceGeneration,
        baseInputGenerationId,
        clockSec,
        captureKind: "exact-publication-inputs",
        liquidityStale: false,
        redemptionStale: false,
        inputFreshness: {
          dexLiquidity: { stale: false },
          redemptionBackstops: { stale: false },
        },
      },
      compiledFacts: {
        activeAssetIds: assetIds,
        assets: orderedSpecs.map((spec) => ({ assetId: spec.id, archetype: "fixture" })),
        baseInputGenerationId,
        v9FactSetDigest: factSetDigest,
        asOfSec: clockSec,
        sourceFingerprints: {
          registry: { generationId: sourceGenerations.registry },
        },
      },
      evaluatedSet: {
        assets: orderedSpecs.map((spec) => ({
          assetId: spec.id,
          scoreInput: scoreInput(spec),
          stressState: {
            exitPortfolio: {
              circulatingUsd: spec.supplyUsd === undefined ? 1 : spec.supplyUsd,
            },
          },
        })),
        baseInputGenerationId,
        factSetDigest,
        scoreResultDigest: resultDigest,
        policyId: IDENTITY.policyId,
        policyDigest: IDENTITY.policyDigest,
        evaluationBuildDigest: IDENTITY.evaluationBuildDigest,
        asOfSec: clockSec,
        sourceGenerations,
      },
      candidate: {
        model: "v9-critical-path",
        schemaVersion: 2,
        lifecycle: "candidate",
        candidateId: "safety-score-v9-candidate:fixture",
        policyVersion: "candidate-v2",
        publicationGenerationId: `publication:g${index}`,
        baseInputGenerationId,
        factSetDigest,
        resultDigest,
        policy: { id: IDENTITY.policyId, semanticDigest: IDENTITY.policyDigest },
        evaluationBuildDigest: IDENTITY.evaluationBuildDigest,
        sourceGenerations,
        asOfSec: clockSec,
        publishedAtSec: clockSec,
        completeness: {
          expectedCount: cards.length,
          ratedCount: cards.filter((entry) => entry.grade !== "NR").length,
          notRatedCount: cards.filter((entry) => entry.grade === "NR").length,
          notRatedIds: cards.filter((entry) => entry.grade === "NR").map((entry) => entry.id),
        },
        cards,
      },
      candidateIdentity: IDENTITY,
      compilerFactSchemaDigest: IDENTITY.compilerFactSchemaDigest,
      producerCapabilityDigest: IDENTITY.producerCapabilityDigest,
    },
  };
}

function validationEvidence(
  specs: readonly CardSpec[] = PASSING_SPECS,
  options: {
    v8Specs?: readonly CardSpec[];
    classifications?: readonly V9ProductionV8MovementClassificationEvidence[];
    candidateGenerationIndex?: number;
  } = {},
): V9ProductionSupplementalValidationEvidence {
  const candidateGenerationIndex = options.candidateGenerationIndex ?? 3;
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-production-validation-evidence",
    candidateIdentity: IDENTITY,
    candidateResult: {
      candidateId: "safety-score-v9-candidate:fixture",
      baseInputGenerationId:
        `report-cards-input:v1:${String(candidateGenerationIndex).repeat(64)}`,
      factSetDigest: (candidateGenerationIndex + 3).toString(16).repeat(64),
      resultDigest: (candidateGenerationIndex + 6).toString(16).repeat(64),
    },
    qualitativeSentinels: V9_PRODUCTION_REQUIRED_QUALITATIVE_SENTINEL_IDS.map((id) => ({
      id,
      passed: true,
      detail: `${id} passed its reviewed production trace.`,
      evidenceRefs: [`tests:${id}`],
    })),
    syntheticAPlusScenarios: [
      {
        scenarioId: "fiat-a-plus",
        archetype: "fiat-cash",
        score: 91,
        grade: "A+",
        resultDigest: "1".repeat(64),
      },
      {
        scenarioId: "cdp-a-plus",
        archetype: "cdp",
        score: 90,
        grade: "A+",
        resultDigest: "2".repeat(64),
      },
      {
        scenarioId: "commodity-a-plus",
        archetype: "commodity",
        score: 89,
        grade: "A+",
        resultDigest: "3".repeat(64),
      },
    ],
    monotonicControls: V9_PRODUCTION_REQUIRED_MONOTONIC_CONTROL_IDS.map((id) => ({
      id,
      caseCount: 100,
      failureCount: 0,
      evidenceRefs: [`tests:${id}`],
    })),
    v8: {
      cards: [...(options.v8Specs ?? specs)]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((spec) => ({ id: spec.id, grade: spec.grade })),
      movementClassifications: [...(options.classifications ?? [])],
    },
  };
}

function failingDistributionSpecs(): CardSpec[] {
  return [
    ...Array.from({ length: 14 }, (_, index) => ({
      id: `asset-${String(index + 1).padStart(2, "0")}`,
      score: 40,
      grade: "D" as const,
      syntheticEvidenceFloor: true,
    })),
    {
      id: "usdc-circle",
      score: 40,
      grade: "D" as const,
      syntheticEvidenceFloor: true,
    },
    {
      id: "usdt-tether",
      score: 40,
      grade: "D" as const,
      syntheticEvidenceFloor: true,
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `nr-${String(index + 1).padStart(2, "0")}`,
      score: null,
      grade: "NR" as const,
    })),
  ];
}

describe("Safety Score v9 production acceptance", () => {
  it("passes three complete, identity-consistent, discriminating, stable generations", () => {
    const report = evaluateV9ProductionAcceptance(
      [generation(3), generation(1), generation(2)],
      { validationEvidence: validationEvidence() },
    );

    expect(report.decision).toBe("gate-passed");
    expect(report.noGoReasons).toEqual([]);
    expect(report.stability).toMatchObject({
      generationCountPassed: true,
      consecutiveCompleteGenerationCount: 3,
      observationWindowSec: 172_800,
      identitiesMatch: true,
      assetSetsMatch: true,
      sequenceValid: true,
      movements: [],
    });
    expect(report.generations.map((entry) => entry.complete)).toEqual([true, true, true]);
    expect(report.generations.map((entry) => entry.clockSec)).toEqual([1_000, 87_400, 173_800]);
    expect(report.generations[0]!.distribution.gates.every((gate) => gate.passed)).toBe(true);
    expect(report.validationEvidence).toMatchObject({
      provided: true,
      identityMatches: true,
      namedSentinelsPassed: true,
      adverseControlsPassed: true,
      monotonicControlsPassed: true,
    });
  });

  it("reports every requested distribution failure", () => {
    const specs = failingDistributionSpecs();
    const report = evaluateV9ProductionAcceptance(
      [generation(1, specs), generation(2, specs), generation(3, specs)],
      { validationEvidence: validationEvidence(specs) },
    );
    const distribution = report.generations[0]!.distribution;

    expect(report.decision).toBe("no-go");
    expect(report.noGoReasons).toContain("distribution-gate-failed");
    expect(distribution.gates.filter((gate) => !gate.passed).map((gate) => gate.id)).toEqual([
      "b-minus-or-better-share",
      "c-plus-through-d-share",
      "d-share",
      "exact-score-bucket-share",
      "not-rated-share",
      "ex-top-two-b-minus-or-better-supply-share",
      "synthetic-evidence-floor-count",
    ]);
    expect(distribution.syntheticEvidenceFloorIds).toHaveLength(16);
    expect(distribution.largestExactScoreBucket).toMatchObject({ score: 40, count: 16 });
  });

  it("reports NR separately and never lets an NR increase satisfy the distribution gate", () => {
    const specs = PASSING_SPECS.map((spec, index) =>
      index < 5 ? { ...spec, score: null, grade: "NR" as const } : spec,
    );
    const report = evaluateV9ProductionAcceptance(
      [generation(1, specs), generation(2, specs), generation(3, specs)],
      { validationEvidence: validationEvidence(specs) },
    );
    const distribution = report.generations[0]!.distribution;

    expect(distribution.ratedCount).toBe(PASSING_SPECS.length - 5);
    expect(distribution.notRated).toMatchObject({ count: 5, shareBps: 1_724 });
    expect(distribution.gates.find((gate) => gate.id === "not-rated-share")?.passed).toBe(false);
    expect(report.noGoReasons).toContain("distribution-gate-failed");
  });

  it("fails internal and cross-generation identity and asset-set mismatches", () => {
    const mismatched = generation(2);
    mismatched.pipeline.candidateIdentity = {
      ...mismatched.pipeline.candidateIdentity,
      policyDigest: "f".repeat(64),
    };
    mismatched.pipeline.fixedInput.activeAssetIds = mismatched.pipeline.fixedInput.activeAssetIds.slice(1);

    const report = evaluateV9ProductionAcceptance(
      [generation(1), mismatched, generation(3)],
      { validationEvidence: validationEvidence() },
    );

    expect(report.noGoReasons).toEqual(
      expect.arrayContaining([
        "generation-internal-identity-mismatch",
        "generation-identity-mismatch",
        "generation-internal-asset-set-mismatch",
        "generation-asset-set-mismatch",
        "generation-incomplete",
      ]),
    );
    expect(report.generations[1]).toMatchObject({
      internalIdentityPassed: false,
      internalAssetSetPassed: false,
      complete: false,
    });
  });

  it("requires an economic or disclosure cause for large grade and flagship movements", () => {
    const secondSpecs = PASSING_SPECS.map((spec) => {
      if (spec.id === "usdc-circle") return { ...spec, score: 74.5, grade: "B" as const };
      if (spec.id === "asset-02") {
        return {
          ...spec,
          score: 64.5,
          grade: "C+" as const,
          scoreInputTrackRecordMonths: 12,
        };
      }
      return spec;
    });
    const first = generation(1);
    const second = generation(2, secondSpecs);
    const third = generation(3, secondSpecs);
    const firstUsdcSpec = PASSING_SPECS.find((spec) => spec.id === "usdc-circle")!;
    const secondUsdc = second.pipeline.evaluatedSet.assets.find((asset) => asset.assetId === "usdc-circle")!;
    const thirdUsdc = third.pipeline.evaluatedSet.assets.find((asset) => asset.assetId === "usdc-circle")!;
    secondUsdc.scoreInput = scoreInput(firstUsdcSpec);
    thirdUsdc.scoreInput = scoreInput(firstUsdcSpec);

    const report = evaluateV9ProductionAcceptance(
      [first, second, third],
      { validationEvidence: validationEvidence(secondSpecs) },
    );
    const usdc = report.stability.movements.find((movement) => movement.assetId === "usdc-circle")!;
    const explained = report.stability.movements.find((movement) => movement.assetId === "asset-02")!;

    expect(usdc).toMatchObject({
      scoreDelta: -10.5,
      gradeDistance: 3,
      flagship: true,
      scoreBearingInputChanged: false,
      economicOrDisclosureCauseChanged: false,
      unexplainedGradeMovement: true,
      unexplainedFlagshipMovement: true,
    });
    expect(explained).toMatchObject({
      scoreBearingInputChanged: true,
      economicOrDisclosureCauseChanged: true,
      cause: "economic-or-disclosure",
      unexplainedGradeMovement: false,
      unexplainedFlagshipMovement: false,
    });
    expect(explained.changedEconomicOrDisclosureFields).toContain("trackRecordMonths");
  });

  it("never treats producer, integration, or method availability as downgrade attribution", () => {
    for (const responsibility of [
      "producer-failed",
      "integration-missing",
      "method-unsupported",
    ] as const) {
      const secondSpecs = PASSING_SPECS.map((spec) =>
        spec.id === "usdc-circle"
          ? {
              ...spec,
              score: 74,
              grade: "B" as const,
              scoreInputReason: {
                code: "missing-runtime-route-evidence" as const,
                responsibility,
              },
            }
          : spec,
      );
      const report = evaluateV9ProductionAcceptance(
        [generation(1), generation(2, secondSpecs), generation(3, secondSpecs)],
        { validationEvidence: validationEvidence(secondSpecs) },
      );
      const movement = report.stability.movements.find(
        (entry) => entry.assetId === "usdc-circle",
      )!;

      expect(movement).toMatchObject({
        cause: "availability-only",
        availabilityCauseChanged: true,
        economicOrDisclosureCauseChanged: false,
        producerCausedDowngrade: true,
        unexplainedGradeMovement: true,
        unexplainedFlagshipMovement: true,
      });
      expect(movement.changedAvailabilityResponsibilities).toContain(responsibility);
      expect(report.noGoReasons).toContain("producer-caused-downgrade");
    }
  });

  it("does not launder an availability-owned structural signal into an economic cause", () => {
    const secondSpecs = PASSING_SPECS.map((spec) =>
      spec.id === "usdc-circle"
        ? { ...spec, score: 74, grade: "B" as const }
        : spec,
    );
    const second = generation(2, secondSpecs);
    const third = generation(3, secondSpecs);
    for (const candidate of [second, third]) {
      const usdc = candidate.pipeline.evaluatedSet.assets.find(
        (asset) => asset.assetId === "usdc-circle",
      )!;
      Object.assign(usdc.scoreInput.pillars.exit, {
        structuralSignals: [{
          kind: "weak-oracle-branch",
          severity: "high",
          reason: "The route oracle observation failed in the producer.",
          responsibility: "producer-failed",
          materialSharePct: 25,
          economicLossScope: "access-only",
          recoveryPath: "market-substitution",
          expectedRecoverySec: 3_600,
          lossAbsorptionPct: 10,
          evidenceConfidence: "unknown",
          pricedInPillar: "exit",
          failureDomainKeys: ["oracle:route"],
        }],
      });
    }

    const report = evaluateV9ProductionAcceptance(
      [generation(1), second, third],
      { validationEvidence: validationEvidence(secondSpecs) },
    );
    const movement = report.stability.movements.find(
      (entry) => entry.assetId === "usdc-circle",
    )!;

    expect(movement).toMatchObject({
      cause: "availability-only",
      availabilityCauseChanged: true,
      economicOrDisclosureCauseChanged: false,
      producerCausedDowngrade: true,
    });
    expect(movement.changedScoreBearingFields).toContain(
      "pillars.exit.structuralSignals",
    );
    expect(movement.changedAvailabilityFields).toContain(
      "pillars.exit.structuralSignals",
    );
    expect(movement.changedAvailabilityResponsibilities).toContain(
      "producer-failed",
    );
  });

  it("attributes applied dependency-role projection changes in the semantic stability trace", () => {
    const secondSpecs = PASSING_SPECS.map((spec) =>
      spec.id === "usdc-circle"
        ? { ...spec, score: 74, grade: "B" as const }
        : spec,
    );
    const first = generation(1);
    const second = generation(2, secondSpecs);
    const third = generation(3, secondSpecs);
    const unchangedScoreInput = scoreInput(
      PASSING_SPECS.find((spec) => spec.id === "usdc-circle")!,
    );
    for (const [candidate, dependencyInputs] of [
      [first, roleDependencyInputs(85, 85)],
      [second, roleDependencyInputs(56, 74)],
      [third, roleDependencyInputs(56, 74)],
    ] as const) {
      const usdc = candidate.pipeline.evaluatedSet.assets.find(
        (asset) => asset.assetId === "usdc-circle",
      )!;
      usdc.scoreInput = structuredClone(unchangedScoreInput);
      Object.assign(usdc, { dependencyInputs });
    }

    const report = evaluateV9ProductionAcceptance(
      [first, second, third],
      { validationEvidence: validationEvidence(secondSpecs) },
    );
    const movement = report.stability.movements.find(
      (entry) => entry.assetId === "usdc-circle",
    )!;

    expect(movement).toMatchObject({
      scoreBearingInputChanged: true,
      economicOrDisclosureCauseChanged: true,
      cause: "economic-or-disclosure",
      producerCausedDowngrade: false,
      unexplainedGradeMovement: false,
      unexplainedFlagshipMovement: false,
    });
    expect(
      movement.changedScoreBearingFields.some((path) =>
        path.startsWith("dependencyRoles."),
      ),
    ).toBe(true);
    expect(
      movement.changedEconomicOrDisclosureFields.some((path) =>
        path.startsWith("dependencyRoles."),
      ),
    ).toBe(true);
  });

  it("tracks structural and dependency exposure identity and share changes", () => {
    type MutableStructuralAsset = {
      scoreInput: {
        pillars: {
          backing: {
            structuralSignals: unknown[];
          };
        };
      };
    };
    const secondSpecs = PASSING_SPECS.map((spec) =>
      spec.id === "usdc-circle"
        ? { ...spec, score: 74, grade: "B" as const }
        : spec,
    );
    const unchangedScoreInput = scoreInput(
      PASSING_SPECS.find((spec) => spec.id === "usdc-circle")!,
    );
    const structuralSignal = (exposureKey: string, riskEventKey: string) => ({
      kind: "material-bridge",
      severity: "high",
      reason: "A deployment-local bridge event affects this holder slice.",
      responsibility: "measured-adverse",
      materialSharePct: 25,
      economicLossScope: "deployment",
      exposureKey,
      riskEventKey,
      recoveryPath: "deployment-migration",
      expectedRecoverySec: 86_400,
      lossAbsorptionPct: 25,
      evidenceConfidence: "high",
      pricedInPillar: "backing",
      failureDomainKeys: ["bridge:role-upstream"],
    });
    const cases = [
      {
        label: "structural exposure identity",
        prepareFirst: (asset: MutableStructuralAsset) => {
          asset.scoreInput.pillars.backing.structuralSignals = [
            structuralSignal("deployment:old", "bridge-event:shared"),
          ];
        },
        prepareNext: (asset: MutableStructuralAsset) => {
          asset.scoreInput.pillars.backing.structuralSignals = [
            structuralSignal("deployment:new", "bridge-event:shared"),
          ];
        },
        expectedPath: "pillars.backing.structuralSignals",
      },
      {
        label: "structural risk-event identity",
        prepareFirst: (asset: MutableStructuralAsset) => {
          asset.scoreInput.pillars.backing.structuralSignals = [
            structuralSignal("deployment:shared", "bridge-event:old"),
          ];
        },
        prepareNext: (asset: MutableStructuralAsset) => {
          asset.scoreInput.pillars.backing.structuralSignals = [
            structuralSignal("deployment:shared", "bridge-event:new"),
          ];
        },
        expectedPath: "pillars.backing.structuralSignals",
      },
      {
        label: "dependency role exposure identity",
        firstDependencies: roleDependencyInputs(85, 85, {
          exposureKey: "exit:old",
          eventExposureKey: "exit:event-shared",
        }),
        nextDependencies: roleDependencyInputs(85, 85, {
          exposureKey: "exit:new",
          eventExposureKey: "exit:event-shared",
        }),
        expectedPath: "dependencyRoles.roleInputs",
      },
      {
        label: "dependency role risk-event identity",
        firstDependencies: roleDependencyInputs(85, 85, {
          riskEventKey: "dependency-event:old",
          eventRiskEventKey: "dependency-event:event-shared",
        }),
        nextDependencies: roleDependencyInputs(85, 85, {
          riskEventKey: "dependency-event:new",
          eventRiskEventKey: "dependency-event:event-shared",
        }),
        expectedPath: "dependencyRoles.roleInputs",
      },
      {
        label: "dependency event exposure identity",
        firstDependencies: roleDependencyInputs(85, 85, {
          eventExposureKey: "exit:event-old",
        }),
        nextDependencies: roleDependencyInputs(85, 85, {
          eventExposureKey: "exit:event-new",
        }),
        expectedPath: "dependencyRoles.rolePillarProjections.exit.events",
      },
      {
        label: "dependency event risk-event identity",
        firstDependencies: roleDependencyInputs(85, 85, {
          eventRiskEventKey: "dependency-event:event-old",
        }),
        nextDependencies: roleDependencyInputs(85, 85, {
          eventRiskEventKey: "dependency-event:event-new",
        }),
        expectedPath: "dependencyRoles.rolePillarProjections.exit.events",
      },
      {
        label: "dependency nominal exposure share",
        firstDependencies: roleDependencyInputs(85, 85, {
          nominalExposureShare: 0.25,
        }),
        nextDependencies: roleDependencyInputs(85, 85, {
          nominalExposureShare: 0.5,
        }),
        expectedPath: "dependencyRoles.rolePillarProjections.exit.events",
      },
      {
        label: "dependency effective exposure share",
        firstDependencies: roleDependencyInputs(85, 85, {
          exposureShare: 0.25,
        }),
        nextDependencies: roleDependencyInputs(85, 85, {
          exposureShare: 0.2,
        }),
        expectedPath: "dependencyRoles.rolePillarProjections.exit.events",
      },
    ] as const;

    for (const testCase of cases) {
      const first = generation(1);
      const second = generation(2, secondSpecs);
      const third = generation(3, secondSpecs);
      const assets = [first, second, third].map((candidate) =>
        candidate.pipeline.evaluatedSet.assets.find(
          (asset) => asset.assetId === "usdc-circle",
        )!,
      );
      for (const asset of assets) {
        asset.scoreInput = structuredClone(unchangedScoreInput);
      }
      if ("prepareFirst" in testCase) {
        testCase.prepareFirst(assets[0] as unknown as MutableStructuralAsset);
        testCase.prepareNext(assets[1] as unknown as MutableStructuralAsset);
        testCase.prepareNext(assets[2] as unknown as MutableStructuralAsset);
      }
      if ("firstDependencies" in testCase) {
        Object.assign(assets[0]!, {
          dependencyInputs: structuredClone(testCase.firstDependencies),
        });
        Object.assign(assets[1]!, {
          dependencyInputs: structuredClone(testCase.nextDependencies),
        });
        Object.assign(assets[2]!, {
          dependencyInputs: structuredClone(testCase.nextDependencies),
        });
      }

      const report = evaluateV9ProductionAcceptance(
        [first, second, third],
        { validationEvidence: validationEvidence(secondSpecs) },
      );
      const movement = report.stability.movements.find(
        (entry) => entry.assetId === "usdc-circle",
      )!;
      expect(movement.economicOrDisclosureCauseChanged, testCase.label).toBe(true);
      expect(
        movement.changedScoreBearingFields,
        testCase.label,
      ).toContain(testCase.expectedPath);
    }
  });

  it("does not let a favorable disclosure change disguise a producer-caused downgrade", () => {
    const firstSpecs = PASSING_SPECS.map((spec) =>
      spec.id === "usdc-circle"
        ? {
            ...spec,
            scoreInputReason: {
              code: "missing-reserve-composition" as const,
              responsibility: "issuer-undisclosed" as const,
            },
          }
        : spec,
    );
    const secondSpecs = PASSING_SPECS.map((spec) =>
      spec.id === "usdc-circle"
        ? {
            ...spec,
            score: 74,
            grade: "B" as const,
            scoreInputReason: {
              code: "missing-runtime-route-evidence" as const,
              responsibility: "producer-failed" as const,
            },
          }
        : spec,
    );
    const report = evaluateV9ProductionAcceptance(
      [generation(1, firstSpecs), generation(2, secondSpecs), generation(3, secondSpecs)],
      { validationEvidence: validationEvidence(secondSpecs) },
    );
    const movement = report.stability.movements.find((entry) => entry.assetId === "usdc-circle")!;

    expect(movement).toMatchObject({
      cause: "availability-only",
      economicOrDisclosureCauseChanged: false,
      producerCausedDowngrade: true,
    });
  });

  it("does not let a simultaneous adverse disclosure disguise a producer-caused downgrade", () => {
    const secondSpecs = PASSING_SPECS.map((spec) =>
      spec.id === "usdc-circle"
        ? { ...spec, score: 74, grade: "B" as const }
        : spec,
    );
    const second = generation(2, secondSpecs);
    const third = generation(3, secondSpecs);
    for (const candidate of [second, third]) {
      const usdc = candidate.pipeline.evaluatedSet.assets.find(
        (asset) => asset.assetId === "usdc-circle",
      )!;
      usdc.scoreInput.pillars.exit.reasons = [
        {
          code: "missing-reserve-composition",
          path: "backing.reserves",
          message: "Issuer disclosure regressed.",
          responsibility: "issuer-undisclosed",
        },
        {
          code: "missing-runtime-route-evidence",
          path: "exit.routes.primary",
          message: "Producer route evidence is missing.",
          responsibility: "producer-failed",
        },
      ];
    }
    const report = evaluateV9ProductionAcceptance(
      [generation(1), second, third],
      { validationEvidence: validationEvidence(secondSpecs) },
    );
    const movement = report.stability.movements.find(
      (entry) => entry.assetId === "usdc-circle",
    )!;

    expect(movement).toMatchObject({
      cause: "mixed",
      economicOrDisclosureCauseChanged: true,
      availabilityCauseChanged: true,
      producerCausedDowngrade: true,
    });
    expect(report.noGoReasons).toContain("producer-caused-downgrade");
  });

  it("accepts issuer nondisclosure as a real disclosure cause", () => {
    const secondSpecs = PASSING_SPECS.map((spec) =>
      spec.id === "usdc-circle"
        ? {
            ...spec,
            score: 74,
            grade: "B" as const,
            scoreInputReason: {
              code: "missing-reserve-composition" as const,
              responsibility: "issuer-undisclosed" as const,
            },
          }
        : spec,
    );
    const report = evaluateV9ProductionAcceptance(
      [generation(1), generation(2, secondSpecs), generation(3, secondSpecs)],
      { validationEvidence: validationEvidence(secondSpecs) },
    );
    const movement = report.stability.movements.find((entry) => entry.assetId === "usdc-circle")!;

    expect(movement).toMatchObject({
      cause: "economic-or-disclosure",
      economicOrDisclosureCauseChanged: true,
      availabilityCauseChanged: false,
      producerCausedDowngrade: false,
      unexplainedGradeMovement: false,
      unexplainedFlagshipMovement: false,
    });
  });

  it("requires a trailing streak of three complete exact and fresh generations", () => {
    const stale = generation(2);
    stale.pipeline.fixedInput.liquidityStale = true;
    stale.pipeline.fixedInput.inputFreshness.dexLiquidity.stale = true;
    const report = evaluateV9ProductionAcceptance(
      [generation(1), stale, generation(3)],
      { validationEvidence: validationEvidence() },
    );

    expect(report.stability).toMatchObject({
      generationCountPassed: false,
      consecutiveCompleteGenerationCount: 1,
      qualifyingSourceGenerations: [],
      sequenceValid: false,
    });
    expect(report.generations[1]!.completenessIssues).toEqual(
      expect.arrayContaining([
        "fixed-input liquidity source is stale",
        "fixed-input source dexLiquidity is stale",
      ]),
    );
    expect(report.noGoReasons).toContain("generation-incomplete");
  });

  it("quantizes real fractional production supply to cents with half-cent-up behavior", () => {
    expect(toV9ProductionSupplyCents(582_158_587.5483115)).toBe(58_215_858_755);
    expect(toV9ProductionSupplyCents(151_180_444.19902566)).toBe(15_118_044_420);
    expect(toV9ProductionSupplyCents(0.1 + 0.2)).toBe(30);
    expect(toV9ProductionSupplyCents(1.004999)).toBe(100);
    expect(toV9ProductionSupplyCents(1.005)).toBe(101);
    expect(toV9ProductionSupplyCents(0.004999)).toBe(0);
    expect(toV9ProductionSupplyCents(0.005)).toBe(1);
    expect(toV9ProductionSupplyCents(0)).toBe(0);
    expect(toV9ProductionSupplyCents(-1)).toBeNull();
    expect(toV9ProductionSupplyCents(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toV9ProductionSupplyCents(Number.NaN)).toBeNull();
    expect(toV9ProductionSupplyCents(100_000_000_000_000)).toBeNull();
  });

  it("accepts fractional-USD production supplies after deterministic quantization", () => {
    const specs = PASSING_SPECS.map((spec, index) => ({
      ...spec,
      supplyUsd:
        index === 0
          ? 582_158_587.5483115
          : index === 1
            ? 151_180_444.19902566
            : 100 + index + 0.123456,
    }));
    const report = evaluateV9ProductionAcceptance(
      [generation(1, specs), generation(2, specs), generation(3, specs)],
      { validationEvidence: validationEvidence(specs) },
    );

    expect(report.generations.every((entry) => entry.supplyValid)).toBe(true);
    expect(
      report.generations[0]!.distribution.gates.find(
        (gate) => gate.id === "supply-input-validity",
      ),
    ).toMatchObject({ passed: true, actual: 0 });
  });

  it("evaluates the supply-share boundary from exact integer cents", () => {
    const specsAtThreshold = PASSING_SPECS.map((spec) => ({
      ...spec,
      supplyUsd:
        spec.id === "asset-01"
          ? 0.445
          : spec.id === "asset-11"
            ? 0.55
            : 0,
    }));
    const atThreshold = evaluateV9ProductionAcceptance(
      [
        generation(1, specsAtThreshold),
        generation(2, specsAtThreshold),
        generation(3, specsAtThreshold),
      ],
      { validationEvidence: validationEvidence(specsAtThreshold) },
    );
    expect(
      atThreshold.generations[0]!.distribution.gates.find(
        (gate) => gate.id === "ex-top-two-b-minus-or-better-supply-share",
      ),
    ).toMatchObject({
      passed: true,
      actual: 4_500,
      numerator: 0.45,
      denominator: 1,
    });

    const specsBelowThreshold = specsAtThreshold.map((spec) =>
      spec.id === "asset-01" ? { ...spec, supplyUsd: 0.435 } : spec,
    );
    const belowThreshold = evaluateV9ProductionAcceptance(
      [
        generation(1, specsBelowThreshold),
        generation(2, specsBelowThreshold),
        generation(3, specsBelowThreshold),
      ],
      { validationEvidence: validationEvidence(specsBelowThreshold) },
    );
    expect(
      belowThreshold.generations[0]!.distribution.gates.find(
        (gate) => gate.id === "ex-top-two-b-minus-or-better-supply-share",
      ),
    ).toMatchObject({ passed: false, actual: 4_444 });
  });

  it("returns a structured no-go for null, malformed, nonfinite, negative, or overflowing supply", () => {
    for (const supplyUsd of [
      null,
      "not-a-number",
      Number.POSITIVE_INFINITY,
      Number.MAX_VALUE,
      -1,
      100_000_000_000_000,
    ]) {
      const specs = PASSING_SPECS.map((spec) =>
        spec.id === "asset-01" ? { ...spec, supplyUsd } : spec,
      );
      const report = evaluateV9ProductionAcceptance(
        [generation(1, specs), generation(2, specs), generation(3, specs)],
        { validationEvidence: validationEvidence(specs) },
      );

      expect(report.decision).toBe("no-go");
      expect(report.noGoReasons).toEqual(
        expect.arrayContaining([
          "generation-incomplete",
          "generation-supply-invalid",
          "distribution-gate-failed",
        ]),
      );
      expect(report.generations[0]).toMatchObject({
        complete: false,
        supplyValid: false,
      });
      expect(report.generations[0]!.distribution.invalidSupplyAssetIds).toEqual(["asset-01"]);
      expect(
        report.generations[0]!.distribution.gates.find(
          (gate) => gate.id === "supply-input-validity",
        ),
      ).toMatchObject({ passed: false, actual: 1 });
    }
  });

  it("fails closed when individually bounded supply rows exceed the aggregate economic bound", () => {
    const specs = PASSING_SPECS.map((spec) => ({
      ...spec,
      supplyUsd: 1_000_000_000_000,
    }));
    const report = evaluateV9ProductionAcceptance(
      [generation(1, specs), generation(2, specs), generation(3, specs)],
      { validationEvidence: validationEvidence(specs) },
    );

    expect(report.decision).toBe("no-go");
    expect(report.noGoReasons).toContain("generation-supply-invalid");
    expect(report.generations[0]!.supplyIssues).toContain(
      "aggregate circulating USD supply must not exceed 20000000000000",
    );
    expect(
      report.generations[0]!.distribution.gates.find(
        (gate) => gate.id === "supply-input-validity",
      ),
    ).toMatchObject({ passed: false, actual: 1 });
  });

  it("gates named sentinels, adverse pins, synthetic A+, and monotonic suites", () => {
    const specs = PASSING_SPECS.map((spec) =>
      spec.id === "dai-makerdao"
        ? { ...spec, score: 59, grade: "C" as const }
        : spec.id === "u-united-stables"
          ? { ...spec, score: 50, grade: "C-" as const }
          : spec,
    );
    const evidence = validationEvidence(specs);
    evidence.syntheticAPlusScenarios = evidence.syntheticAPlusScenarios.slice(0, 2);
    evidence.monotonicControls = evidence.monotonicControls.map((control) =>
      control.id === "pillar-improvement-monotonic"
        ? { ...control, failureCount: 1 }
        : control,
    );
    const report = evaluateV9ProductionAcceptance(
      [generation(1, specs), generation(2, specs), generation(3, specs)],
      { validationEvidence: evidence },
    );

    expect(report.validationEvidence.namedSentinelsPassed).toBe(false);
    expect(report.validationEvidence.adverseControlsPassed).toBe(false);
    expect(report.validationEvidence.syntheticAPlus.passed).toBe(false);
    expect(report.validationEvidence.monotonicControlsPassed).toBe(false);
    expect(report.noGoReasons).toEqual(
      expect.arrayContaining([
        "named-sentinel-gate-failed",
        "adverse-control-gate-failed",
        "synthetic-a-plus-gate-failed",
        "monotonic-control-gate-failed",
      ]),
    );
  });

  it("rejects duplicate qualitative sentinel IDs instead of accepting the last claim", () => {
    const evidence = validationEvidence();
    evidence.qualitativeSentinels = [
      ...evidence.qualitativeSentinels,
      {
        ...evidence.qualitativeSentinels[0]!,
        detail: "Conflicting duplicate claim.",
      },
    ];
    const report = evaluateV9ProductionAcceptance(
      [generation(1), generation(2), generation(3)],
      { validationEvidence: evidence },
    );

    expect(report.validationEvidence.namedSentinelsPassed).toBe(false);
    expect(report.validationEvidence.adverseControlsPassed).toBe(false);
    expect(report.validationEvidence.issues).toContain(
      "Qualitative sentinel evidence IDs must be unique",
    );
  });

  it("requires every two-band V8 movement to be classified and blocks producer gaps or defects", () => {
    const v8Specs = PASSING_SPECS.map((spec) =>
      spec.id === "dai-makerdao" ? { ...spec, score: 90, grade: "A+" as const } : spec,
    );
    const missing = evaluateV9ProductionAcceptance(
      [generation(1), generation(2), generation(3)],
      { validationEvidence: validationEvidence(PASSING_SPECS, { v8Specs }) },
    );
    expect(missing.validationEvidence.v8Classification).toMatchObject({
      passed: false,
      requiredMovementCount: 1,
      classifiedMovementCount: 0,
    });

    const intentional = validationEvidence(PASSING_SPECS, {
      v8Specs,
      classifications: [{
        assetId: "dai-makerdao",
        classification: "intentional-strictness",
        summary: "The V9 result reflects an adjudicated material weakness.",
        evidenceRefs: ["packet:dai-v8-transition"],
      }],
    });
    const passed = evaluateV9ProductionAcceptance(
      [generation(1), generation(2), generation(3)],
      { validationEvidence: intentional },
    );
    expect(passed.validationEvidence.v8Classification.passed).toBe(true);

    const producerGap = structuredClone(intentional);
    producerGap.v8.movementClassifications[0]!.classification = "producer-gap";
    const blocked = evaluateV9ProductionAcceptance(
      [generation(1), generation(2), generation(3)],
      { validationEvidence: producerGap },
    );
    expect(blocked.validationEvidence.v8Classification.passed).toBe(false);
    expect(blocked.noGoReasons).toContain("v8-classification-gate-failed");
  });

  it("reports missing candidate-bound validation evidence explicitly", () => {
    const report = evaluateV9ProductionAcceptance([
      generation(1),
      generation(2),
      generation(3),
    ]);

    expect(report.decision).toBe("no-go");
    expect(report.noGoReasons).toEqual(
      expect.arrayContaining([
        "validation-evidence-missing",
        "synthetic-a-plus-gate-failed",
        "monotonic-control-gate-failed",
        "v8-classification-gate-failed",
      ]),
    );
    expect(report.validationEvidence.provided).toBe(false);
  });

  it("rejects supplemental evidence bound to a different candidate result", () => {
    const evidence = validationEvidence();
    evidence.candidateResult = {
      ...evidence.candidateResult,
      resultDigest: "f".repeat(64),
    };
    const report = evaluateV9ProductionAcceptance(
      [generation(1), generation(2), generation(3)],
      { validationEvidence: evidence },
    );

    expect(report.validationEvidence).toMatchObject({
      provided: true,
      identityMatches: true,
      candidateResultMatches: false,
      namedSentinelsPassed: false,
      adverseControlsPassed: false,
      monotonicControlsPassed: false,
    });
    expect(report.validationEvidence.issues).toContain(
      "Supplemental validation evidence does not bind the latest candidate result",
    );
  });

  it("does not accept self-authored replay claims without locally rebuilding exact caches", async () => {
    const inputs = new Map<string, unknown>([
      ["generation-1.json", generation(1)],
      ["generation-2.json", generation(2)],
      ["generation-3.json", generation(3)],
      ["exact-cache-1.json", {}],
      ["exact-cache-2.json", {}],
      ["exact-cache-3.json", {}],
    ]);
    let output = "";
    let stdout = "";
    const io: V9ProductionValidationIo = {
      readJson: (path) => inputs.get(path),
      writeText: (_path, contents) => {
        output = contents;
      },
      sourceReceipt: () => SOURCE_RECEIPT,
      stdout: {
        write: (text) => {
          stdout += text;
        },
      },
    };

    await expect(
      runV9ProductionValidationCli(
        [
          "--generation",
          "generation-1.json",
          "--generation",
          "generation-2.json",
          "--generation",
          "generation-3.json",
          "--exact-cache",
          "exact-cache-1.json",
          "--exact-cache",
          "exact-cache-2.json",
          "--exact-cache",
          "exact-cache-3.json",
          "--output",
          "report.json",
        ],
        io,
      ),
    ).rejects.toThrow("Safety Score v9 strict production acceptance is no-go");

    expect(JSON.parse(output)).toMatchObject({
      kind: "safety-score-v9-strict-production-acceptance",
      decision: "no-go",
      noGoReasons: expect.arrayContaining([
        "acceptance-contract-failed",
        "capture-ledger-missing",
        "generation-verification-failed",
        "holdout-missing",
      ]),
      generationVerifications: [
        { inputIndex: 0, verified: false },
        { inputIndex: 1, verified: false },
        { inputIndex: 2, verified: false },
      ],
    });
    expect(stdout).toContain("no-go");
  });

  it("writes a structured no-go report before the strict CLI exits nonzero", async () => {
    const inputs = new Map<string, unknown>([
      ["generation-1.json", generation(1)],
      ["holdout-scorer-proof.json", {}],
    ]);
    let output = "";
    const io: V9ProductionValidationIo = {
      readJson: (path) => inputs.get(path),
      writeText: (_path, contents) => {
        output = contents;
      },
      sourceReceipt: () => SOURCE_RECEIPT,
      stdout: { write: () => undefined },
    };

    await expect(
      runV9ProductionValidationCli(
        [
          "--generation",
          "generation-1.json",
          "--holdout-scorer-proof",
          "holdout-scorer-proof.json",
          "--output",
          "report.json",
        ],
        io,
      ),
    ).rejects.toThrow("Safety Score v9 strict production acceptance is no-go");

    expect(JSON.parse(output)).toMatchObject({
      kind: "safety-score-v9-strict-production-acceptance",
      decision: "no-go",
      noGoReasons: expect.arrayContaining([
        "acceptance-contract-failed",
        "capture-ledger-missing",
        "generation-verification-failed",
        "holdout-missing",
      ]),
      captureLedger: {
        provided: false,
        continuityPassed: false,
      },
      holdout: {
        provided: false,
        scorerProofProvided: true,
        scorerProofParsed: false,
        decisionPassed: false,
      },
    });
  });

  it("rejects the retired reviewer-authored validation evidence option", async () => {
    const io: V9ProductionValidationIo = {
      readJson: () => undefined,
      writeText: () => undefined,
      sourceReceipt: () => SOURCE_RECEIPT,
      stdout: { write: () => undefined },
    };

    await expect(
      runV9ProductionValidationCli(
        [
          "--generation",
          "generation-1.json",
          "--validation-evidence",
          "validation-evidence.json",
          "--output",
          "report.json",
        ],
        io,
      ),
    ).rejects.toThrow();
  });
});
