import { describe, expect, it } from "vitest";
import {
  projectV9RoleDependencyPillarLimits,
  type V9ResolvedDependencyInputs,
} from "../safety-score-v9/dependencies";
import type { V9CapTrace, V9NRReason } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9PublicCardProjectionInput } from "../safety-score-v9/public";
import { buildSafetyScoreV9Response, projectSafetyScoreV9Card } from "../safety-score-v9/public";
import type { V9ProductionScoreTrace } from "../safety-score-v9/score";

const DIGESTS = {
  policy: "a".repeat(64),
  facts: "b".repeat(64),
  base: `report-cards-input:v1:${"c".repeat(64)}`,
  build: "d".repeat(64),
  stress: "e".repeat(64),
} as const;

const freshness = { backing: "current", exit: "current", control: "current" } as const;
const access = {
  transfer: "permissionless" as const,
  freezeExposure: "none-known" as const,
  primaryExit: "permissionless" as const,
  governance: "distributed" as const,
  unknownFields: [],
  signals: ["freeze:none-known", "governance:distributed", "primary-exit:permissionless", "transfer:permissionless"],
};

interface FixtureOptions {
  score: number | null;
  grade: V9ProductionScoreTrace["finalGrade"];
  pillars?: { backing: number | null; exit: number | null; control: number | null };
  qualityScore?: number | null;
  pegAdjustedScore?: number | null;
  caps?: readonly V9CapTrace[];
  nrReasons?: readonly V9NRReason[];
  dependency?: V9PublicCardProjectionInput["dependencyInputs"];
}

function fixture(assetId: string, options: FixtureOptions): V9PublicCardProjectionInput {
  const pillars = options.pillars ?? { backing: 92, exit: 90, control: 94 };
  const qualityScore =
    options.qualityScore === undefined ? (options.score === null ? null : 91.8) : options.qualityScore;
  const pegAdjustedScore =
    options.pegAdjustedScore === undefined ? (options.score === null ? null : qualityScore) : options.pegAdjustedScore;
  const caps = options.caps ?? [];
  const nrReasons = options.nrReasons ?? [];
  const pillarContributions = (["backing", "exit", "control"] as const).flatMap((pillar) => {
    const score = pillars[pillar];
    return score === null
      ? []
      : [
          {
            pillar,
            score,
            weight: pillar === "backing" ? 0.4 : pillar === "exit" ? 0.35 : 0.25,
            weightedContribution: score,
          },
        ];
  });
  const trace: V9ProductionScoreTrace = {
    assetId,
    policyId: "safety-score-v9",
    policyDigest: DIGESTS.policy,
    configName: "safety-score-v9",
    pillarContributions,
    weightedQuality: qualityScore,
    weakestPillar: Object.values(pillars).some((score) => score === null)
      ? null
      : { pillar: "exit", score: pillars.exit! },
    aggregation:
      qualityScore === null
        ? null
        : {
            method: "smooth-bounded-headroom",
            score: qualityScore,
            weightedQuality: qualityScore,
            weakestPillar: "exit",
            weakestScore: pillars.exit!,
            headroom: 45,
          },
    pegMultiplier: pegAdjustedScore === null ? null : 1,
    baseAssetScore: pegAdjustedScore,
    deploymentAdjustedScore: pegAdjustedScore,
    deploymentAdjustments: [],
    unresolvedDeploymentSignals: [],
    preCapScore: pegAdjustedScore,
    scoreAdjustments: [],
    caps,
    bindingCap: caps.find((cap) => cap.binding) ?? null,
    structuralSignals: [],
    finalScore: options.score,
    inheritableScore: options.score,
    finalGrade: options.grade,
    adverseAttribution: [],
    boundedUncertaintyAttribution: [],
    unresolvedFacts: [],
    nrReasons,
    propagatedParentReasons: [],
    factSetDigest: DIGESTS.facts,
    baseInputGenerationId: DIGESTS.base,
    evaluationBuildDigest: DIGESTS.build,
    asOfSec: 1_000,
    sourceGenerations: { dex: "dex:g1", registry: "registry:g1" },
    operationalResilience: null,
    wrapperParentLimit: null,
  };
  const dependencyInputs = options.dependency ?? { assetId, serial: [], basket: [], cycleBlocked: false };
  const dependencyReasons = dependencyInputs.serial.some((dependency) => dependency.blocked)
    ? [
        {
          code: "missing-parent-score" as const,
          path: `dependency:serial:${dependencyInputs.serial[0]!.upstreamAssetId}`,
          message: "Required upstream is not rateable.",
          responsibility: "integration-missing" as const,
        },
      ]
    : [];

  return {
    trace,
    policy: V9_CANDIDATE_POLICY_V1,
    scoreInput: {
      pillars: {
        backing: {
          score: pillars.backing,
          evidenceLevel: pillars.backing === null ? "insufficient" : "strong",
          reasons:
            pillars.backing === null
              ? [{
                  code: "missing-pillar-evidence",
                  path: "backing",
                  message: "Backing evidence is missing.",
                  responsibility: "integration-missing",
                }]
              : [],
          structuralSignals: [],
        },
        exit: { score: pillars.exit, evidenceLevel: "strong", reasons: [], structuralSignals: [] },
        control: { score: pillars.control, evidenceLevel: "strong", reasons: [], structuralSignals: [] },
      },
      peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
      dependencyReasons,
      methodologyReasons: [],
    },
    access,
    dependencyInputs,
    stressState: { stateDigest: DIGESTS.stress },
    backing: {
      archetype: "fiat-cash",
      score: pillars.backing,
      contributions:
        pillars.backing === null
          ? []
          : [{
              componentKey: "reserve:cash",
              source: "reserve-exposure",
              score: pillars.backing,
              normalizedWeight: 1,
              weightedScore: pillars.backing,
              observationState: "known",
              provenance: "curated",
              evidenceRefIds: [],
              failureDomains: [],
              upstreamAssetId: null,
            }],
    },
    exit: {
      score: pillars.exit,
      stressRequest:
        pillars.exit === null
          ? null
          : {
              requestedNotionalUsd: 1_000_000,
              maxCostBps: 200,
              comparisonWindowSec: 86_400,
              rawSupplyRequestUsd: 1_000_000,
            },
      primaryRouteKey: pillars.exit === null ? null : "redemption:fixture",
      diversificationRouteKey: null,
      diversificationBonus: 0,
      routes:
        pillars.exit === null
          ? []
          : [{
              routeKey: "redemption:fixture",
              routeFamily: "protocol-redemption",
              observationConfidence: "high",
              modelConfidence: "high",
              observationHistory: null,
              horizon: "immediate",
              capacityScoringHorizon: "immediate",
              settlementDelaySec: 0,
              queueDepthUsd: null,
              dailyLimitUsd: null,
              minRedeemUsd: null,
              score: pillars.exit,
              included: true,
              exclusionReason: null,
              capacityPoint: {
                requestedNotionalUsd: 1_000_000,
                maxCostBps: 200,
                executableUsd: 1_000_000,
                completionRatio: 1,
                executionCostBps: 0,
              },
              components: {
                access: pillars.exit,
                settlement: pillars.exit,
                executionCertainty: pillars.exit,
                capacity: pillars.exit,
                outputAssetQuality: pillars.exit,
                cost: pillars.exit,
              },
              confidenceFactor: 1,
              capsApplied: [],
            }],
    },
    control: {
      score: pillars.control,
      components:
        pillars.control === null
          ? []
          : [{
              componentKey: "control:mint",
              kind: "mint",
              posture: "bounded-admin",
              score: pillars.control,
              binding: true,
              controlKeys: [],
              failureDomains: [],
            }],
    },
    display: {
      labels: {
        "reserve:cash": "Cash",
        "redemption:fixture": "Protocol redemption",
        "control:mint": "Mint control",
      },
      exitHolderEligibility: { "redemption:fixture": "any-holder" },
    },
    freshness,
  };
}

function cap(args: Pick<V9CapTrace, "kind" | "limit" | "source" | "reason" | "binding">): V9CapTrace {
  return args;
}

describe("Safety Score v9 public projection", () => {
  it("publishes complete, capped, dependency-bound, and NR V9 fixtures", () => {
    const complete = fixture("complete", { score: 91.8, grade: "A+" });
    const capped = fixture("capped", {
      score: 64,
      grade: "C+",
      caps: [
        cap({
          kind: "bounded-compensability",
          limit: 98,
          source: "bounded-compensability",
          reason: "Weakest-pillar headroom.",
          binding: false,
        }),
        cap({
          kind: "signal:material-bridge:high",
          limit: 64,
          source: "structural",
          reason: "A material bridge binds.",
          binding: true,
        }),
      ],
    });
    const dependency = fixture("dependency", {
      score: 75,
      grade: "B+",
      caps: [cap({ kind: "parent", limit: 75, source: "parent", reason: "Required parent ceiling.", binding: true })],
      dependency: {
        assetId: "dependency",
        serial: [{ upstreamAssetId: "upstream", score: 75, blocked: false }],
        basket: [],
        cycleBlocked: false,
      },
    });
    const notRated = fixture("not-rated", {
      score: null,
      grade: "NR",
      pillars: { backing: null, exit: 90, control: 94 },
      nrReasons: [{ code: "missing-pillar", field: "pillars.backing", message: "Backing is missing." }],
    });

    const response = buildSafetyScoreV9Response({
      candidateId: "safety-score-v9:v1:public-test",
      policyVersion: "9.0",
      publicationGenerationId: "report-cards:v9:v1:public-test",
      publishedAtSec: 1_001,
      results: [notRated, dependency, complete, capped],
    });

    expect(response.model).toBe("v9-critical-path");
    expect(response.schemaVersion).toBe(5);
    expect(response.lifecycle).toBe("active");
    expect(response.cards.map((card) => card.id)).toEqual(["capped", "complete", "dependency", "not-rated"]);
    expect(response.completeness).toEqual({
      expectedCount: 4,
      ratedCount: 3,
      notRatedCount: 1,
      notRatedIds: ["not-rated"],
    });
    expect(response.cards[0]?.caps).toHaveLength(2);
    expect(response.cards[1]?.breakdowns).toMatchObject({
      backing: {
        evaluatedScore: 92,
        publishedScore: 92,
        aggregationWeight: 0.4,
        groups: [{ key: "reserves", effectiveWeight: 1 }],
        components: [{
          key: "reserve:cash",
          label: "Cash",
          score: 92,
          effectiveWeight: 1,
          weightedContribution: 92,
        }],
      },
      exit: {
        evaluatedScore: 90,
        primaryRoute: {
          key: "redemption:fixture",
          label: "Protocol redemption",
          confidenceFactor: 1,
          eligibilityMultiplier: 1,
        },
      },
      control: {
        evaluatedScore: 94,
        method: "minimum-binding-component",
      },
    });
    expect(response.cards[0]?.bindingCap?.kind).toBe("signal:material-bridge:high");
    expect(response.cards[2]?.dependencies.serial[0]?.upstreamAssetId).toBe("upstream");
    expect(response.cards[2]?.bindingCap?.source).toBe("parent");
    expect(response.cards[3]?.nrReasons).toEqual([
      { code: "missing-pillar", field: "pillars.backing", message: "Backing is missing.", origin: "asset" },
    ]);
    expect(response.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(response.cards.every((card) => card.scoreTrace.schemaVersion === 3)).toBe(true);
  });

  it("publishes the applied role limit with its exact evidence and failure domains", () => {
    const unresolved: V9ResolvedDependencyInputs = {
      assetId: "role-dependent",
      serial: [],
      basket: [],
      roleInputs: [
        {
          assetId: "role-dependent",
          upstreamAssetId: "operator",
          edgeKey: "control-operator:mechanism:operator",
          exposureKey: "control-operator:mechanism:operator",
          riskEventKey: "dependency-event:mint-control:operator:shared",
          dependencyType: "mechanism",
          role: "control-operator",
          weight: 0.5,
          inheritedDimensions: ["control"],
          unavailableDimensions: [],
          score: 76,
          boundedUnknown: false,
          cycleBlocked: false,
          evidenceRefIds: ["evidence:operator-review"],
          failureDomains: [{ kind: "mint-control", key: "operator:shared" }],
        },
      ],
      cycleBlocked: false,
    };
    const dependency: V9ResolvedDependencyInputs = {
      ...unresolved,
      rolePillarProjections: projectV9RoleDependencyPillarLimits(unresolved, {
        unresolvedMaterialityThreshold: 0.1,
      }),
    };

    const card = projectSafetyScoreV9Card(
      (() => {
        const input = fixture("role-dependent", {
        score: 91,
        grade: "A+",
        pillars: { backing: 92, exit: 90, control: 88 },
        qualityScore: 91,
        pegAdjustedScore: 91,
        dependency,
        });
        input.control = {
          score: 94,
          components: [{
            componentKey: "control:mint",
            kind: "mint",
            posture: "bounded-admin",
            score: 94,
            binding: true,
            controlKeys: [],
            failureDomains: [],
          }],
        };
        return input;
      })(),
    );

    expect(card.dependencies.roles).toEqual([
      expect.objectContaining({
        edgeKey: "control-operator:mechanism:operator",
        exposureKey: "control-operator:mechanism:operator",
        riskEventKey: "dependency-event:mint-control:operator:shared",
        targetPillar: "control",
        propagationEventEdgeKeys: ["control-operator:mechanism:operator"],
        propagationEventExposureKey: "control-operator:mechanism:operator",
        propagationEventRiskEventKey: "dependency-event:mint-control:operator:shared",
        propagationEventNominalExposureShare: 0.5,
        propagationEventExposureShare: 0.5,
        propagationEventInheritedScore: 76,
        propagationEventModeledLossPoints: 12,
        evidenceRefIds: ["evidence:operator-review"],
        failureDomains: [{ kind: "mint-control", key: "operator:shared" }],
      }),
    ]);
    expect(card.dependencies.rolePillarLimits?.control).toMatchObject({
      limit: 88,
      knownLossPoints: 12,
      unresolvedExposureShare: 0,
    });
    expect(card.breakdowns?.control.adjustments).toEqual([{
      kind: "dependency-limit",
      scoreBefore: 94,
      scoreAfter: 88,
      delta: -6,
    }]);
  });

  it("keeps access unknowns, evidence owners, aggregation, and all score stages explicit", () => {
    const input = fixture("unknown-access", { score: 91.8, grade: "A+" });
    input.access = {
      transfer: "unknown",
      freezeExposure: "possible",
      primaryExit: "permissionless",
      governance: "unknown",
      unknownFields: ["governance", "transfer"],
      signals: ["freeze:possible", "governance:unknown", "primary-exit:permissionless", "transfer:unknown"],
      reasons: [
        {
          code: "unresolved-control-identity",
          path: "access:governance",
          message: "Governance is unresolved.",
          responsibility: "issuer-undisclosed",
        },
      ],
    };
    input.freshness = { backing: "current", exit: "stale", control: "current" };
    input.evidenceReasons = [{
      code: "historical-critical-input",
      path: "exit",
      message: "Exit evidence is stale.",
      responsibility: "producer-failed",
    }];
    input.trace.unresolvedFacts = [
      {
        code: "historical-critical-input",
        path: "exit",
        reason: "Exit evidence is stale.",
        critical: false,
        responsibility: "producer-failed",
      },
      {
        code: "unresolved-control-identity",
        path: "access:governance",
        reason: "Governance is unresolved.",
        critical: false,
        responsibility: "issuer-undisclosed",
      },
    ];

    const card = projectSafetyScoreV9Card(input);

    expect(card).toMatchObject({
      qualityScore: 91.8,
      pegMultiplier: 1,
      pegAdjustedScore: 91.8,
      evidence: { level: "strong", freshness: "stale" },
      accessPosture: { unknownFields: ["governance", "transfer"] },
      stressStateDigest: DIGESTS.stress,
      scoreTrace: {
        schemaVersion: 3,
        legacyAliases: {
          qualityScore: "weighted-pillar-mean",
          pegAdjustedScore: "post-deployment-pre-cap-score",
          score: "post-cap-public-score",
        },
        aggregation: {
          method: "smooth-bounded-headroom",
          weightedPillarMean: 91.8,
          score: 91.8,
        },
        stages: {
          weightedPillarMean: 91.8,
          aggregatedQualityScore: 91.8,
          baseAssetScore: 91.8,
          deploymentAdjustedScore: 91.8,
          deploymentAdjustmentPoints: 0,
          preCapScore: 91.8,
          publishedScore: 91.8,
        },
        deploymentRisk: {
          method: "holder-slice-exposure-weighted-v2",
          totalAdjustmentPoints: 0,
          adjustments: [],
          unresolvedExposures: [],
        },
        adverseAttribution: { semantics: "causal-measured-adverse-v1", items: [] },
        boundedUncertaintyAttribution: {
          semantics: "causal-bounded-uncertainty-v1",
          items: [],
        },
        evidenceResponsibility: { semantics: "limiting-fact-owner-v1", totalFactCount: 2 },
      },
    });
    expect(card.scoreTrace.evidenceResponsibility.summaries).toEqual([
      { responsibility: "integration-missing", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
      {
        responsibility: "issuer-undisclosed",
        factCount: 1,
        criticalFactCount: 0,
        reasonCodes: ["unresolved-control-identity"],
      },
      { responsibility: "measured-adverse", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
      { responsibility: "method-unsupported", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
      {
        responsibility: "producer-failed",
        factCount: 1,
        criticalFactCount: 0,
        reasonCodes: ["historical-critical-input"],
      },
    ]);
    expect(card.reasonCodes).toEqual(["historical-critical-input", "unresolved-control-identity"]);
  });

  it("attributes exposure-weighted deployment loss and causal adverse evidence", () => {
    const input = fixture("deployment-risk", { score: 80, grade: "A-" });
    input.trace.baseAssetScore = 91.8;
    input.trace.deploymentAdjustedScore = 88.8;
    input.trace.preCapScore = 88.8;
    input.trace.finalScore = 80;
    input.trace.deploymentAdjustments = [
      {
        signalKey: "signal:material-bridge:high:bridge-a",
        sourceSignalKeys: ["signal:material-bridge:high:bridge-a"],
        exposureKey: "deployment:bridge-a",
        riskEventKey: "bridge-failure:a",
        failureDomainKey: "bridge-a",
        nominalExposureShare: 0.1,
        exposureShare: 0.1,
        exposedScore: 61.8,
        scoreBefore: 91.8,
        scoreAfter: 88.8,
        adjustmentPoints: 3,
        reason: "Ten percent of supply inherits bridge failure risk.",
      },
    ];
    input.trace.unresolvedDeploymentSignals = [
      {
        signalKey: "signal:material-bridge:medium:bridge-b",
        exposureKey: "deployment:bridge-b",
        riskEventKey: "bridge-failure:b",
        failureDomainKeys: ["bridge-b"],
        economicLossScope: "deployment",
        exposedScore: 75,
        exposureShare: null,
        reason: "Bridge supply share is unresolved.",
      },
    ];
    input.trace.adverseAttribution = [
      {
        source: "structural-signal",
        path: "structural:material-bridge:high",
        message: "The measured bridge exposure lowers holder safety.",
        responsibility: "measured-adverse",
      },
    ];

    const card = projectSafetyScoreV9Card(input);

    expect(card.scoreTrace.deploymentRisk).toEqual({
      method: "holder-slice-exposure-weighted-v2",
      totalAdjustmentPoints: 3,
      adjustments: [
        {
          signalKey: "signal:material-bridge:high:bridge-a",
          sourceSignalKeys: ["signal:material-bridge:high:bridge-a"],
          exposureKey: "deployment:bridge-a",
          riskEventKey: "bridge-failure:a",
          failureDomainKey: "bridge-a",
          nominalExposureShare: 0.1,
          exposureShare: 0.1,
          exposedScore: 61.8,
          scoreBefore: 91.8,
          scoreAfter: 88.8,
          adjustmentPoints: 3,
          modeledLossPoints: 3,
          reason: "Ten percent of supply inherits bridge failure risk.",
        },
      ],
      unresolvedExposures: [
        {
          signalKey: "signal:material-bridge:medium:bridge-b",
          exposureKey: "deployment:bridge-b",
          riskEventKey: "bridge-failure:b",
          failureDomainKeys: ["bridge-b"],
          economicLossScope: "deployment",
          exposedScore: 75,
          exposureShare: null,
          reason: "Bridge supply share is unresolved.",
        },
      ],
    });
    expect(card.scoreTrace.adverseAttribution).toEqual({
      semantics: "causal-measured-adverse-v1",
      items: input.trace.adverseAttribution,
    });
  });

  it("projects the native USDT premium as an explicit score stage", () => {
    const cap: V9CapTrace = {
      source: "structural",
      kind: "signal:centralized-mint:low",
      limit: 87,
      reason: "Eligible USDT market-anchor cap relief.",
      binding: true,
    };
    const input = fixture("usdt-tether", {
      score: 87,
      grade: "A+",
      pillars: { backing: 95, exit: 95, control: 95 },
      qualityScore: 95,
      pegAdjustedScore: 99,
      caps: [cap],
    });
    input.trace.baseAssetScore = 95;
    input.trace.deploymentAdjustedScore = 95;
    input.trace.inheritableScore = 83;
    input.trace.scoreAdjustments = [{
      source: "asset-premium",
      kind: "market-anchor-longevity",
      label: "#1 & Longevity Premium",
      configuredPoints: 4,
      appliedPoints: 4,
      scoreBefore: 95,
      scoreAfter: 99,
      publishedScoreBefore: 83,
      publishedScoreAfter: 87,
      capRelief: {
        source: "structural",
        kind: "signal:centralized-mint:low",
        fromLimit: 83,
        toLimit: 87,
      },
    }];

    const card = projectSafetyScoreV9Card(input);

    expect(card.scoreTrace.stages).toMatchObject({
      deploymentAdjustedScore: 95,
      preCapScore: 99,
      publishedScore: 87,
    });
    expect(card.scoreTrace.scoreAdjustments).toEqual(input.trace.scoreAdjustments);
  });

  it("rejects duplicate assets and mixed evaluator identities", () => {
    const base = fixture("alpha", { score: 91.8, grade: "A+" });
    expect(() =>
      buildSafetyScoreV9Response({
        candidateId: "safety-score-v9:v1:public-test",
        policyVersion: "9.0",
        publicationGenerationId: "report-cards:v9:v1:public-test",
        publishedAtSec: 1_001,
        results: [base, base],
      }),
    ).toThrow(/Duplicate/);

    const mixed = fixture("beta", { score: 90, grade: "A+" });
    mixed.trace.evaluationBuildDigest = "f".repeat(64);
    expect(() =>
      buildSafetyScoreV9Response({
        candidateId: "safety-score-v9:v1:public-test",
        policyVersion: "9.0",
        publicationGenerationId: "report-cards:v9:v1:public-test",
        publishedAtSec: 1_001,
        results: [base, mixed],
      }),
    ).toThrow(/mixes evaluation build/);
  });
});
