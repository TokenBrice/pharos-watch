import { describe, expect, it } from "vitest";
import { iterateEvidenceResponsibilityFacts } from "../../types/safety-score-v9-public-evidence-facts";
import { resolveCauseGapId } from "../../types/safety-score-v9-public-cause-gaps";
import {
  projectV9RoleDependencyPillarLimits,
  type V9ResolvedDependencyInputs,
} from "../safety-score-v9/dependencies";
import type { V9CapTrace, V9NRReason } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9PublicCardProjectionInput } from "../safety-score-v9/public";
import {
  buildSafetyScoreV9Response,
  projectSafetyScoreV9Card,
  projectTopDriver,
} from "../safety-score-v9/public";
import type { V9ProductionScoreTrace } from "../safety-score-v9/score";
import {
  SafetyScoreV9AccessPostureSchema,
  SafetyScoreV9CurrentCardSchema,
  SafetyScoreV9CurrentResponseSchema,
  SafetyScoreV9EvidenceSummarySchema,
  SafetyScoreV9PillarSchema,
} from "../../types/safety-score-v9-public";
import { V9_WRAPPER_LOCAL_FACT_KEYS } from "../../types/safety-score-v9-wrapper";
import { makeDeploymentControl } from "./safety-score-v9-fixtures.test-support";
import { weightedQuorum } from "./safety-score-v9-control-scope.test-support";
import supplyAttributionReviews from "../../data/safety-score-v9/supply-attribution-reviews-v1.json";
import { ReviewedProviderRowExclusionSchema } from "../../types/safety-score-v9-supply-attribution";

const DIGESTS = {
  policy: "a".repeat(64),
  facts: "b".repeat(64),
  base: `report-cards-input:v1:${"c".repeat(64)}`,
  build: "d".repeat(64),
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

const knownCause = { cause: null, causeGapIds: [] as string[], scoringDisposition: "included", effectiveScoringWeight: 1 } as const;
const neutralConfidence = { factor: 1, cause: null, causeGapIds: [] as string[] } as const;

function fixture(assetId: string, options: FixtureOptions): V9PublicCardProjectionInput {
  const pillars = options.pillars ?? { backing: 92, exit: 90, control: 94 };
  const qualityScore =
    options.qualityScore === undefined ? (options.score === null ? null : 91.8) : options.qualityScore;
  const pegAdjustedScore =
    options.pegAdjustedScore === undefined ? (options.score === null ? null : qualityScore) : options.pegAdjustedScore;
  const caps = options.caps ?? [];
  const nrReasons = [...(options.nrReasons ?? [])];
  const ratingStatus = options.grade === null ? "pipeline-gap" : options.grade === "NR" ? "not-rated" : "rated";
  const includedPillars = (["backing", "exit", "control"] as const).filter((pillar) => ratingStatus !== "pipeline-gap" || pillars[pillar] !== null);
  const excludedPillars = (["backing", "exit", "control"] as const).filter((pillar) => !includedPillars.includes(pillar));
  if (ratingStatus === "pipeline-gap") nrReasons.push({
    code: includedPillars.length === 0 ? "all-pillars-pipeline-gap" : "single-pillar-pipeline-gap",
    message: "Insufficient supported pillars.",
  });
  const weights = { backing: 0.4, exit: 0.35, control: 0.25 };
  const effectiveScoringWeights = ratingStatus === "pipeline-gap" ? null : weights;
  const pillarFields = (pillar: "backing" | "exit" | "control") => ({
    aggregationDisposition: excludedPillars.includes(pillar) ? "excluded-a-b" as const : "included" as const,
    causeGapIds: pillars[pillar] === null ? [`gap:${pillar}`] : [],
    limitedEvidenceCauses: pillars[pillar] === null && ratingStatus !== "pipeline-gap" ? ["U" as const] : [],
    supportedComponentKeys: pillars[pillar] === null ? [] : [`component:${pillar}`],
  });
  const pillarContributions = (["backing", "exit", "control"] as const).flatMap((pillar) => {
    const score = pillars[pillar];
    return score === null || ratingStatus === "pipeline-gap"
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
    ratingStatus,
    partialEvidence: ratingStatus === "pipeline-gap" ? {
      reasonCode: "partial-evidence-pipeline-gap",
      excludedPillars: [...excludedPillars].sort(),
      excludedComponentKeys: excludedPillars.map((pillar) => `component:${pillar}`).sort(),
      causeGapIds: excludedPillars.map((pillar) => `gap:${pillar}`).sort(), causes: ["A"],
    } : null,
    includedPillars, excludedPillars, effectiveScoringWeights,
    supportCeiling: qualityScore === null ? null : (["backing", "exit", "control"] as const).reduce(
      (sum, pillar) => sum + (pillars[pillar] ?? 0) * weights[pillar], 0,
    ),
    limitingPillars: [], causeGapIds: [], limitedEvidenceCauses: [],
    diagnosticPillarScores: pillars,
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
            includedPillars, excludedPillars, effectiveScoringWeights: weights,
            supportCeiling: (["backing", "exit", "control"] as const).reduce(
              (sum, pillar) => sum + (pillars[pillar] ?? 0) * weights[pillar], 0,
            ),
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
          ...pillarFields("backing"),
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
        exit: { score: pillars.exit, ...pillarFields("exit"), evidenceLevel: "strong", reasons: [], structuralSignals: [] },
        control: { score: pillars.control, ...pillarFields("control"), evidenceLevel: "strong", reasons: [], structuralSignals: [] },
      },
      peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
      dependencyReasons,
      methodologyReasons: [],
    },
    access,
    dependencyInputs,
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
              effectiveWeight: 1,
              ...knownCause, wholeAssetWeight: 1,
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
              ...knownCause,
              confidenceDimensions: { observation: neutralConfidence, model: neutralConfidence, capacityMethod: neutralConfidence },
              capacityEvidenceTier: "live-direct",
              eligibilityMultiplier: 1, rawSameNotionalCostBps: 0, supportedComponentCeiling: pillars.exit,
              factorContributions: Object.fromEntries(Object.entries(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.componentWeights).map(
                ([key, weight]) => [key, { ...knownCause, score: pillars.exit, effectiveScoringWeight: weight }],
              )),
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
              ...knownCause,
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
  it.each([
    ["stray-percent", "literal%", false],
    ["literal-percent-escape", "parent:gap:literal%20", false],
    ["unencoded-colons", "parent:gap:reserve:liquidity", false],
    ["encoded-round-trip", "parent:gap:reserve:liquidity %", true],
  ] as const)("round-trips %s causal paths without inventing foreign gap identities", (assetId, gapId, encoded) => {
    const input = fixture(assetId, { score: 91.8, grade: "A+" });
    input.trace.unresolvedFacts = [{
      code: "unresolved-control-identity",
      path: `control:mint:cause:${encoded ? encodeURIComponent(gapId) : gapId}`,
      reason: "Mint authority is unresolved.",
      critical: false, responsibility: "unresearched", sourceGapId: gapId,
      cause: "U", causeGapIds: [gapId], scoringDisposition: "bounded-uncertainty",
    }];
    const response = buildSafetyScoreV9Response({
      candidateId: "safety-score-v9:v1:causal-path-test", policyVersion: "9.0",
      publicationGenerationId: "report-cards:v9:v1:causal-path-test",
      publishedAtSec: 1_001, results: [input],
    });
    const decoded = SafetyScoreV9CurrentResponseSchema.parse(JSON.parse(JSON.stringify(response)));
    const card = decoded.cards[0]!;
    expect(decoded.foreignCauseGaps).toEqual([gapId]);
    expect(card.localCauseGaps).toEqual([]);
    expect(card.score).toBe(91.8);
    const facts = [...iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)];
    expect(facts).toEqual([[
      "unresolved-control-identity", "control:mint:cause:0", 0, "unresearched", false, "U", [0],
    ]]);
    expect(resolveCauseGapId(decoded, card, facts[0]![2]!)).toBe(gapId);
  });
  it("keeps a pipeline gap distinct from NR while retaining the surviving diagnostic pillar", () => {
    const card = projectSafetyScoreV9Card(fixture("pipeline-gap", {
      score: null, grade: null, pillars: { backing: null, exit: null, control: 94 },
    })).card;
    expect(card).toMatchObject({
      ratingStatus: "pipeline-gap", score: null, grade: null, qualityScore: null,
      pegAdjustedScore: null, pegMultiplier: null, weakestPillar: null, nrReasons: [],
      partialEvidence: { excludedPillars: ["backing", "exit"], causes: ["A"] },
      pillars: { control: { score: 94 } },
      scoreTrace: { aggregation: null },
    });
    expect(card.reasonCodes).toContain("single-pillar-pipeline-gap");
    expect(card.breakdowns?.control.components[0]?.score).toBe(94);
    expect(SafetyScoreV9CurrentCardSchema.safeParse({ ...card, grade: "NR" }).success).toBe(false);
  });
  it.each(["backing", "exit", "control"] as const)(
    "projects post-dependency exclusions while retaining the surviving %s diagnostic",
    surviving => {
      const scores = { backing: 92, exit: 90, control: 94 };
      const diagnosticScores = {
        backing: null as number | null, exit: null as number | null, control: null as number | null,
      };
      diagnosticScores[surviving] = scores[surviving];
      const input = fixture("parent-gap-child", { score: null, grade: null, pillars: diagnosticScores });
      const local = fixture("parent-gap-child", { score: 91.8, grade: "A+" });
      input.backing = local.backing;
      input.exit = local.exit;
      input.control = local.control;
      input.display = local.display;
      if (surviving !== "backing") {
        input.backing = {
          ...input.backing!,
          score: 35,
          contributions: [{
            ...input.backing!.contributions[0]!, score: 35, weightedScore: 35, cause: "D",
            causeGapIds: ["parent-gap-child:gap:known-local-risk"], scoringDisposition: "measured-adverse",
          }],
        };
      }
      const response = buildSafetyScoreV9Response({
        candidateId: "safety-score-v9:v1:parent-gap-test", policyVersion: "9.0",
        publicationGenerationId: "report-cards:v9:v1:parent-gap-test",
        publishedAtSec: 1_001, results: [input],
      });
      const card = SafetyScoreV9CurrentResponseSchema.parse(JSON.parse(JSON.stringify(response))).cards[0]!;
      expect(card).toMatchObject({ ratingStatus: "pipeline-gap", score: null, grade: null });
      for (const pillar of ["backing", "exit", "control"] as const) {
        const breakdown = card.breakdowns![pillar];
        expect(breakdown.aggregationWeight).toBe(0);
        expect(breakdown.evaluatedScore).toBe(pillar === surviving ? scores[pillar] : null);
        expect(breakdown.publishedScore).toBe(pillar === surviving ? scores[pillar] : null);
        expect(breakdown.adjustments).toEqual([]);
      }
      if (surviving !== "backing") {
        const knownRisk = card.breakdowns!.backing.components[0]!;
        expect(knownRisk).toMatchObject({
          score: 35, cause: "D", effectiveScoringWeight: 0, weightedContribution: 0, wholeAssetWeight: 1,
        });
        expect(resolveCauseGapId(response, card, knownRisk.causeGapRefs![0]!))
          .toBe("parent-gap-child:gap:known-local-risk");
      }
      if (surviving !== "control") expect(card.breakdowns!.control.components[0]!)
        .toMatchObject({ score: 94, effectiveScoringWeight: 0, binding: false });
      if (surviving !== "exit") {
        expect(card.breakdowns!.exit.primaryRoute).toBeNull();
        expect(card.breakdowns!.exit.diversification).toBeNull();
        expect(card.breakdowns!.exit.alternatives[0]!).toMatchObject({ score: 90 });
      }
    },
  );
  it("discloses provider-row identity proof and numerator-only scope, omitting absent or empty records byte-for-byte", () => {
    const input = fixture("frax-frax", { score: 70, grade: "B" });
    const baseline = JSON.stringify(projectSafetyScoreV9Card(input).card);
    input.providerRowExclusions = [];
    expect(JSON.stringify(projectSafetyScoreV9Card(input).card)).toBe(baseline);
    const review = ReviewedProviderRowExclusionSchema.parse(supplyAttributionReviews.providerRowExclusionReviews[0]!);
    input.providerRowExclusions = [{ review, deploymentRouteKey: "unmatched-chain:frax-frax:fraxtal", supplyShare: 0.097 }];
    const card = SafetyScoreV9CurrentCardSchema.parse(projectSafetyScoreV9Card(input).card);
    expect(card.scoreTrace.providerRowExclusions).toEqual([{
      review, deploymentRouteKey: "unmatched-chain:frax-frax:fraxtal", supplyShare: 0.097,
    }]);
    expect(card.score).toBe(70);
    expect(card.supply).toEqual(JSON.parse(baseline).supply);
    expect(card.scoreTrace.providerRowExclusions![0]!.review).toMatchObject({
      belongsToAssetId: "frxusd-frax", providerChainLabel: "Fraxtal",
      contractAddress: "0xfc00000000000000000000000000000000000001",
      provenance: { blockNumber: 42061479 },
    });
  });
  it("publishes effective weighted signatures without turning unknown key bypasses into quorum credit", () => {
    const input = fixture("alpha", { score: 70, grade: "B" });
    const weighted = weightedQuorum([...Array<number>(8).fill(24), ...Array<number>(18).fill(1)], 25);
    const control = makeDeploymentControl("control:mint", "mint", {
      authority: { authorityKey: weighted.deployment, model: "multisig", threshold: null, weightedQuorum: weighted },
    });
    input.control = { ...input.control!, components: [{ ...input.control!.components[0]!, controlKeys: [control.controlKey] }], controlFacts: [control] };
    const details = () => SafetyScoreV9CurrentCardSchema.parse(projectSafetyScoreV9Card(input).card).breakdowns!.control.components[0]!.controlDetails![0]!;
    expect(details().minimumCryptographicSignatures).toBe(2);
    control.authority!.weightedQuorum = { ...weighted, masterKey: "enabled" };
    expect(details().minimumCryptographicSignatures).toBe(1);
    control.authority!.weightedQuorum = { ...weighted, regularKey: { state: "unknown" } };
    expect(details().minimumCryptographicSignatures).toBeNull();
  });
  it("publishes wrapper forms only on wrapper claims, not sibling mechanism claims", () => {
    const input = fixture("dependent", {
      score: 64, grade: "C+",
      caps: [cap({ kind: "parent", limit: 64, source: "parent", reason: "Parent limit.", binding: true })],
      dependency: {
        assetId: "dependent", basket: [], cycleBlocked: false,
        serial: [
          { upstreamAssetId: "mechanism", score: 64, blocked: false },
          { upstreamAssetId: "wrapper", score: 64, blocked: false },
        ],
      },
    });
    input.dependencyTypes = new Map([["serial:mechanism", "mechanism"], ["serial:wrapper", "wrapper"]]);
    input.trace.wrapperParentLimit = {
      schemaVersion: 1, parentScore: 64, form: "pure", treatment: "local-facts",
      localRiskDiscount: 0, fallbackDiscount: 0, appliedDiscount: 0, limit: 64,
      riskTransfer: { disposition: "not-applicable", mechanism: "none", requestedCredit: 0, appliedCredit: 0 },
      factsComplete: true, missingFacts: [],
      adjustments: V9_WRAPPER_LOCAL_FACT_KEYS.map((factKey) => ({
        factKey, disposition: "not-applicable", assessment: null, maximumDiscountPoints: 1, discountPoints: 0,
        cause: null, causeGapIds: [], scoringDisposition: "not-applicable",
      })),
    };
    expect(projectSafetyScoreV9Card(input).card.dependencies.serial).toMatchObject([
      { upstreamAssetId: "mechanism", dependencyType: "mechanism", wrapperForm: null },
      { upstreamAssetId: "wrapper", dependencyType: "wrapper", wrapperForm: "pure" },
    ]);
  });

  it("projects cap-bound, pillar-bound, and withheld top drivers from the card", () => {
    const capBound = projectSafetyScoreV9Card(fixture("cap-bound", {
      score: 64,
      grade: "C+",
      caps: [cap({
        kind: "signal:material-bridge:high",
        limit: 64,
        source: "structural",
        reason: "A material bridge binds.",
        binding: true,
      })],
    })).card;
    expect(projectTopDriver(capBound)).toEqual({
      kind: "cap-bound",
      label: "signal:material-bridge:high",
      value: 64,
      reason: "A material bridge binds.",
      evidenceFreshness: "current",
    });

    const pillarBound = projectSafetyScoreV9Card(fixture("pillar-bound", {
      score: 91.8,
      grade: "A+",
    })).card;
    expect(projectTopDriver(pillarBound)).toEqual({
      kind: "pillar-bound",
      label: "exit",
      value: 90,
      reason: null,
      evidenceFreshness: "current",
    });

    const withheld = projectSafetyScoreV9Card(fixture("withheld", {
      score: null,
      grade: "NR",
      pillars: { backing: null, exit: 90, control: 94 },
      nrReasons: [{ code: "missing-pillar", field: "pillars.backing", message: "Backing is missing." }],
    })).card;
    expect(projectTopDriver(withheld)).toEqual({
      kind: "withheld",
      label: null,
      value: null,
      reason: "Backing is missing.",
      evidenceFreshness: "current",
    });
  });

  it("publishes rated, NR and pipeline-gap cards with disjoint completeness counts", () => {
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
    const pipelineGap = fixture("pipeline-gap", {
      score: null, grade: null, pillars: { backing: null, exit: null, control: 94 },
    });

    const response = buildSafetyScoreV9Response({
      candidateId: "safety-score-v9:v1:public-test",
      policyVersion: "9.0",
      publicationGenerationId: "report-cards:v9:v1:public-test",
      publishedAtSec: 1_001,
      results: [notRated, dependency, complete, capped, pipelineGap],
    });

    expect(response.model).toBe("v9-critical-path");
    expect(response.schemaVersion).toBe(6);
    expect(response.lifecycle).toBe("active");
    expect(response.cards.map((card) => card.id)).toEqual(["capped", "complete", "dependency", "not-rated", "pipeline-gap"]);
    expect(response.completeness).toEqual({
      expectedCount: 5,
      ratedCount: 3,
      notRatedCount: 1,
      notRatedIds: ["not-rated"],
      pipelineGapCount: 1, pipelineGapIds: ["pipeline-gap"],
    });
    expect(response.cards[0]?.caps).toHaveLength(2);
    expect(response.cards[1]?.breakdowns).toMatchObject({
      backing: {
        evaluatedScore: 92,
        publishedScore: 92,
        aggregationWeight: 0.4,
        groups: [{ key: "reserves" }],
        components: [{
          key: "reserve:cash",
          label: "Cash",
          score: 92,
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
    expect(response.cards.every((card) => card.scoreTrace.schemaVersion === 4)).toBe(true);
  });

  it("rejects a backing waterfall that does not reconcile to the evaluated pillar", () => {
    const input = fixture("bad-backing-waterfall", { score: 91.8, grade: "A+" });
    input.backing = {
      ...input.backing!,
      contributions: input.backing!.contributions.map((contribution) => ({
        ...contribution,
        effectiveWeight: 0.5,
      })),
    };
    expect(() => projectSafetyScoreV9Card(input).card).toThrow(
      "backing waterfall does not reconcile to its evaluated pillar",
    );
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

    const card = projectSafetyScoreV9Card((() => {
      const input = fixture("role-dependent", {
      score: 90,
      grade: "A+",
      pillars: { backing: 92, exit: 90, control: 88 },
      qualityScore: 90.3,
      pegAdjustedScore: 90.3,
      dependency,
      });
      input.control = {
        score: 94,
        components: [{
          componentKey: "control:mint",
          kind: "mint",
          posture: "bounded-admin",
          score: 94,
          ...knownCause,
          binding: true,
          controlKeys: [],
          failureDomains: [],
        }],
      };
      return input;
    })(),).card;

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
        cause: "A", causeGapIds: ["asset:gap:exit"], scoringDisposition: "excluded-pipeline",
      },
      {
        code: "unresolved-control-identity",
        path: "access:governance",
        reason: "Governance is unresolved.",
        critical: false,
        responsibility: "issuer-undisclosed",
        sourceGapId: "asset:gap:governance",
        cause: "C", causeGapIds: ["asset:gap:governance"], scoringDisposition: "bounded-uncertainty",
      },
    ];

    const projection = projectSafetyScoreV9Card(input);
    const { card } = projection;

    expect(card).toMatchObject({
      qualityScore: 91.8,
      pegMultiplier: 1,
      pegAdjustedScore: 91.8,
      evidence: { level: "strong", freshness: "stale" },
      accessPosture: { unknownFields: ["governance", "transfer"] },
      scoreTrace: {
        schemaVersion: 4,
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
        evidenceResponsibility: { semantics: "limiting-fact-cause-v2", totalFactCount: 2 },
      },
    });
    expect(card.scoreTrace.evidenceResponsibility.summaries.filter((summary) => (summary.factCount ?? 0) > 0)).toEqual([
      { responsibility: "issuer-undisclosed", factCount: 1, reasonCodes: ["unresolved-control-identity"] },
      { responsibility: "producer-failed", factCount: 1, reasonCodes: ["historical-critical-input"] },
    ]);
    const fact = [...iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)]
      .find((row) => row[0] === "unresolved-control-identity")!;
    expect(fact).toMatchObject({ 0: "unresolved-control-identity", 1: "access:governance", 3: "issuer-undisclosed", 4: false, 5: "C" });
    expect(resolveCauseGapId(projection, card, fact[2]!)).toBe("asset:gap:governance");
    expect(fact[6].map((ref) => resolveCauseGapId(projection, card, ref))).toEqual(["asset:gap:governance"]);
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

    const card = projectSafetyScoreV9Card(input).card;

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

    const card = projectSafetyScoreV9Card(input).card;

    expect(card.scoreTrace.stages).toMatchObject({
      deploymentAdjustedScore: 95,
      preCapScore: 99,
      publishedScore: 87,
    });
    expect(card.scoreTrace.scoreAdjustments).toEqual(input.trace.scoreAdjustments);
  });

  function publish(results: V9PublicCardProjectionInput[]) {
    return buildSafetyScoreV9Response({
      candidateId: "safety-score-v9:v1:public-test",
      policyVersion: "9.0",
      publicationGenerationId: "report-cards:v9:v1:public-test",
      publishedAtSec: 1_001,
      results,
    });
  }

  it("rejects empty publications", () => {
    expect(() => publish([])).toThrow(/at least one result/);
  });

  it("rejects each independently mismatched publication identity", () => {
    const baseline = fixture("alpha", { score: 91.8, grade: "A+" });
    const mutations: [Partial<V9ProductionScoreTrace>, RegExp][] = [
      [{ factSetDigest: "e".repeat(64) }, /mixes fact-set digest/],
      [{ baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}` }, /mixes base input generation/],
      [{ policyDigest: "e".repeat(64) }, /mixes policy digest/],
      [{ asOfSec: 999 }, /mixes evidence clock/],
      [{ sourceGenerations: { dex: "dex:g2", registry: "registry:g1" } }, /mixes source generations/],
    ];
    for (const [mutation, error] of mutations) {
      const other = fixture("beta", { score: 90, grade: "A+" });
      expect(publish([baseline, other]).cards.map((card) => card.id)).toEqual(["alpha", "beta"]);
      Object.assign(other.trace, mutation);
      expect(() => publish([baseline, other])).toThrow(error);
    }
  });

  it("canonicalizes source maps and result ordering without losing score changes in the digest", () => {
    const alpha = fixture("alpha", { score: 91.8, grade: "A+" });
    const beta = fixture("beta", { score: 90, grade: "A+" });
    const forward = publish([alpha, beta]);
    beta.trace.sourceGenerations = { registry: "registry:g1", dex: "dex:g1" };
    const reversed = publish([beta, alpha]);
    expect(reversed.cards).toEqual(forward.cards);
    expect(reversed.resultDigest).toBe(forward.resultDigest);
    expect(reversed.sourceGenerations).toEqual({ dex: "dex:g1", registry: "registry:g1" });
    const changed = publish([alpha, fixture("beta", { score: 89, grade: "A+" })]);
    expect(changed.resultDigest).not.toBe(forward.resultDigest);
  });

  it("deduplicates identical reasons through all projector reason lists", () => {
    const input = fixture("repeated-reasons", { score: 91.8, grade: "A+" });
    const reason = { code: "bounded-mechanism-review" as const, path: "backing:mechanism:custody", message: "Reviewed custody." };
    const seamReason = { ...reason, responsibility: "method-unsupported" as const };
    input.scoreInput.pillars.backing.reasons = [seamReason, { ...seamReason }];
    input.evidenceReasons = [seamReason, { ...seamReason }];
    input.access = { ...input.access, reasons: [seamReason, { ...seamReason }] };
    const card = projectSafetyScoreV9Card(input).card;
    const rendered = { code: reason.code, path: reason.path, message: reason.message };
    expect(card.pillars.backing.reasons).toEqual([rendered]);
    expect(card.evidence.reasons).toEqual([rendered]);
    expect(card.accessPosture.reasons).toEqual([rendered]);
  });

  it("rejects conflicting renderings but publishes distinct paths for the same reason code", () => {
    const first = { code: "bounded-mechanism-review" as const, path: "backing:mechanism:custody", message: "First rendering." };
    const second = { ...first, message: "Second rendering." };
    const seamFirst = { ...first, responsibility: "method-unsupported" as const };
    const seamSecond = { ...seamFirst, message: second.message };
    for (const target of ["pillar", "evidence", "access"] as const) {
      const input = fixture(`conflicting-${target}`, { score: 91.8, grade: "A+" });
      const reasons = [seamFirst, seamSecond];
      if (target === "pillar") input.scoreInput.pillars.backing.reasons = reasons;
      if (target === "evidence") input.evidenceReasons = reasons;
      if (target === "access") input.access = { ...input.access, reasons };
      // Conflicting evidence is rejected, not silently assigned an arbitrary winning message.
      expect(() => projectSafetyScoreV9Card(input).card).toThrow(expect.objectContaining({
        issues: [expect.objectContaining({
          code: "custom",
          path: target === "pillar" ? ["pillars", "backing", "reasons", 1]
            : [target === "evidence" ? "evidence" : "accessPosture", "reasons", 1],
        })],
      }));
      reasons[1] = { ...seamSecond, path: "backing:mechanism:reserves" };
      const card = projectSafetyScoreV9Card(input).card;
      const published = target === "pillar" ? card.pillars.backing.reasons
        : target === "evidence" ? card.evidence.reasons : card.accessPosture.reasons;
      expect(published.map(({ code, path, message }) => ({ code, path, message }))).toEqual([
        { code: first.code, path: first.path, message: first.message },
        { code: second.code, path: "backing:mechanism:reserves", message: second.message },
      ]);
    }
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

  it("rejects duplicate code/path identities in every public reason list", () => {
    const duplicateReasons = [
      {
        code: "bounded-mechanism-review" as const,
        message: "First rendering.",
        path: "backing:mechanism:custody",
      },
      {
        code: "bounded-mechanism-review" as const,
        message: "Second rendering.",
        path: "backing:mechanism:custody",
      },
    ];
    expect(
      SafetyScoreV9PillarSchema.safeParse({
        score: 70,
        evidenceLevel: "limited",
        freshness: "current",
        components: [],
        reasons: duplicateReasons,
      }).success,
    ).toBe(false);
    expect(
      SafetyScoreV9EvidenceSummarySchema.safeParse({
        level: "limited",
        freshness: "current",
        reasons: duplicateReasons,
      }).success,
    ).toBe(false);
    expect(
      SafetyScoreV9AccessPostureSchema.safeParse({
        ...access,
        reasons: duplicateReasons,
      }).success,
    ).toBe(false);
  });
});

describe("Safety Score v9 public NR cap suppression", () => {
  const materialityCap = cap({
    source: "evidence",
    kind: "reason:runtime-bridge-materiality-unavailable",
    limit: 55,
    reason: "Bridge materiality is unavailable.",
    binding: true,
  });
  const notRated = () =>
    fixture("not-rated", {
      score: null,
      grade: "NR",
      pillars: { backing: null, exit: 90, control: 94 },
      caps: [materialityCap],
      nrReasons: [{ code: "missing-pillar", field: "pillars.backing", message: "Backing is missing." }],
    });

  it("keeps NR cap candidates as diagnostics but suppresses all binding assertions", () => {
    const card = projectSafetyScoreV9Card(notRated()).card;

    expect(card.score).toBeNull();
    expect(card.bindingCap).toBeNull();
    expect(card.caps).toEqual([
      expect.objectContaining({
        kind: materialityCap.kind,
        limit: materialityCap.limit,
        source: materialityCap.source,
        binding: false,
      }),
    ]);
  });

  it("keeps the rated binding cap unchanged", () => {
    const nonBindingCap = cap({ ...materialityCap, kind: "reason:missing-peg-input", limit: 69, binding: false });
    const card = projectSafetyScoreV9Card(fixture("rated", { score: 91.8, grade: "A+", caps: [nonBindingCap, materialityCap] }),).card;

    expect(card.score).not.toBeNull();
    expect(card.caps).toEqual([
      expect.objectContaining({ kind: nonBindingCap.kind, source: nonBindingCap.source, limit: 69, binding: false }),
      expect.objectContaining({
        kind: materialityCap.kind,
        source: materialityCap.source,
        limit: 55,
        binding: true,
      }),
    ]);
    expect(card.bindingCap).toMatchObject({ kind: materialityCap.kind, limit: 55, binding: true });
  });

  it("rejects hand-built NR cards with a binding cap or binding candidate", () => {
    const card = projectSafetyScoreV9Card(notRated()).card;

    expect(SafetyScoreV9CurrentCardSchema.safeParse({
      ...card,
      bindingCap: { ...card.caps[0]!, binding: true },
    }).success).toBe(false);
    expect(SafetyScoreV9CurrentCardSchema.safeParse({
      ...card,
      caps: card.caps.map((entry) => ({ ...entry, binding: true })),
    }).success).toBe(false);
  });
});
