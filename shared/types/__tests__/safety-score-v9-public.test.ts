import { describe, expect, it } from "vitest";
import {
  SafetyScoreV9CurrentCardSchema,
  SafetyScoreV9CurrentResponseSchema,
  SafetyScoreV9BreakdownsSchema,
  SafetyScoreV9LegacyResponseSchema,
  SafetyScoreV9PreBreakdownResponseSchema,
  SafetyScoreV9ResponseSchema,
} from "../safety-score-v9-public";

const DIGEST = "a".repeat(64);

function pillar(score: number) {
  return {
    score,
    evidenceLevel: "strong",
    freshness: "current",
    components: [],
    reasons: [],
  } as const;
}

function breakdowns(backingScore = 90, exitScore = 92, controlScore = 94) {
  const exitComponents = [
    ["access", "Access", 0.2],
    ["settlement", "Settlement", 0.15],
    ["executionCertainty", "Execution certainty", 0.15],
    ["capacity", "Capacity", 0.25],
    ["outputAssetQuality", "Output asset quality", 0.15],
    ["cost", "Cost", 0.1],
  ] as const;
  return SafetyScoreV9BreakdownsSchema.parse({
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
  });
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

function currentResponse() {
  const current = structuredClone(response()) as unknown as {
    schemaVersion: number;
    lifecycle: string;
    policyVersion: string;
    policy: { id: string; semanticDigest: string };
    cards: Array<{ scoreTrace?: unknown; breakdowns?: unknown }>;
  };
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
  };
  current.cards[0]!.breakdowns = breakdowns();
  return current;
}

interface MutableAdjustmentFixture {
  source: string;
  kind: string;
  label: string;
  configuredPoints: number;
  appliedPoints: number;
  scoreBefore: number;
  scoreAfter: number;
  publishedScoreBefore: number;
  publishedScoreAfter: number;
  capRelief: {
    source: string;
    kind: string;
    fromLimit: number;
    toLimit: number;
  };
}

interface MutableAdjustedCardFixture {
  score: number;
  grade: string;
  pegAdjustedScore: number;
  caps: Array<{
    kind: string;
    limit: number;
    source: string;
    reason: string;
    binding: boolean;
  }>;
  bindingCap: {
    kind: string;
    limit: number;
    source: string;
    reason: string;
    binding: boolean;
  } | null;
  scoreTrace: {
    stages: { preCapScore: number; publishedScore: number };
    scoreAdjustments: MutableAdjustmentFixture[];
  };
}

type MutableAdjustedResponseFixture =
  Omit<ReturnType<typeof currentResponse>, "cards"> & {
    cards: MutableAdjustedCardFixture[];
  };

function adjustedResponse(): MutableAdjustedResponseFixture {
  const adjusted = currentResponse() as unknown as MutableAdjustedResponseFixture;
  const card = adjusted.cards[0]!;
  const structuralCap = {
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

describe("SafetyScoreV9ResponseSchema", () => {
  it("retains a strict schema-v1 reader for persisted candidate artifacts", () => {
    const parsed = SafetyScoreV9LegacyResponseSchema.parse(response());
    expect(parsed.cards[0]?.grade).toBe("A+");
    expect(parsed.lifecycle).toBe("candidate");
    expect(SafetyScoreV9ResponseSchema.parse(parsed).schemaVersion).toBe(1);
  });

  it("requires the self-describing score trace on every current V9 card", () => {
    const parsed = SafetyScoreV9CurrentResponseSchema.parse(currentResponse());
    expect(parsed.schemaVersion).toBe(5);
    expect(parsed.cards[0]?.scoreTrace.aggregation?.method).toBe("smooth-bounded-headroom");
    expect(parsed.cards[0]?.scoreTrace.legacyAliases.pegAdjustedScore).toBe(
      "post-deployment-pre-cap-score",
    );
    expect(SafetyScoreV9ResponseSchema.parse(parsed).schemaVersion).toBe(5);

    const missingTrace = currentResponse();
    delete missingTrace.cards[0]!.scoreTrace;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(missingTrace)).toThrow();

    const inconsistentTrace = currentResponse();
    const scoreTrace = inconsistentTrace.cards[0]!.scoreTrace as {
      stages: { preCapScore: number };
    };
    scoreTrace.stages.preCapScore = 91;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(inconsistentTrace)).toThrow(
      /explicit preCapScore must match/,
    );
  });

  it("reads pre-attribution schema-v2 artifacts with an empty bounded trace", () => {
    const previous = currentResponse();
    previous.schemaVersion = 2;
    previous.lifecycle = "candidate";
    previous.policyVersion = "candidate-v1";
    previous.policy = { id: "safety-score-v9-candidate-v1", semanticDigest: "d".repeat(64) };
    delete previous.cards[0]!.breakdowns;
    const trace = previous.cards[0]!.scoreTrace as Record<string, unknown>;
    trace.schemaVersion = 1;
    delete trace.boundedUncertaintyAttribution;
    delete trace.scoreAdjustments;

    const parsed = SafetyScoreV9ResponseSchema.parse(previous);
    expect(parsed.schemaVersion).toBe(2);
    expect("scoreTrace" in parsed.cards[0]!).toBe(true);
    expect(
      "scoreTrace" in parsed.cards[0]! &&
      parsed.cards[0]!.scoreTrace.schemaVersion,
    ).toBe(1);
  });

  it("retains exact schema-v3 and trace-v2 causal artifacts", () => {
    const causal = currentResponse();
    causal.schemaVersion = 3;
    causal.lifecycle = "candidate";
    causal.policyVersion = "candidate-v1";
    causal.policy = { id: "safety-score-v9-candidate-v1", semanticDigest: "d".repeat(64) };
    delete causal.cards[0]!.breakdowns;
    const trace = causal.cards[0]!.scoreTrace as Record<string, unknown>;
    trace.schemaVersion = 2;
    delete trace.scoreAdjustments;

    const parsed = SafetyScoreV9ResponseSchema.parse(causal);
    expect(parsed.schemaVersion).toBe(3);
    expect(
      "scoreTrace" in parsed.cards[0]! &&
      !("scoreAdjustments" in parsed.cards[0]!.scoreTrace),
    ).toBe(true);
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(causal)).toThrow();
  });

  it("retains exact candidate-v4 cards without component breakdowns", () => {
    const previous = currentResponse();
    previous.schemaVersion = 4;
    previous.lifecycle = "candidate";
    previous.policyVersion = "candidate-v1";
    previous.policy = {
      id: "safety-score-v9-candidate-v1",
      semanticDigest: "d".repeat(64),
    };
    delete previous.cards[0]!.breakdowns;

    expect(SafetyScoreV9PreBreakdownResponseSchema.parse(previous).schemaVersion).toBe(4);
    expect(SafetyScoreV9ResponseSchema.parse(previous).schemaVersion).toBe(4);
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(previous)).toThrow();
  });

  it("cannot downgrade a response-v4 candidate by relabeling only its traces", () => {
    const downgraded = currentResponse();
    const trace = downgraded.cards[0]!.scoreTrace as Record<string, unknown>;
    trace.schemaVersion = 1;
    delete trace.boundedUncertaintyAttribution;
    delete trace.scoreAdjustments;

    expect(() => SafetyScoreV9ResponseSchema.parse(downgraded)).toThrow();
  });

  it("rejects component breakdowns that do not reconcile their public scores", () => {
    const invalidBacking = structuredClone(
      SafetyScoreV9CurrentResponseSchema.parse(currentResponse()),
    );
    invalidBacking.cards[0]!.breakdowns!.backing.components[0]!.weightedContribution = 89;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(invalidBacking)).toThrow(
      /backing weighted contribution|backing components must reconcile/,
    );

    const invalidExit = structuredClone(
      SafetyScoreV9CurrentResponseSchema.parse(currentResponse()),
    );
    invalidExit.cards[0]!.breakdowns!.exit.primaryRoute!.components[0]!.weightedContribution = 1;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(invalidExit)).toThrow(
      /exit weighted contribution|primary-route score must reconcile/,
    );

    const invalidControl = structuredClone(
      SafetyScoreV9CurrentResponseSchema.parse(currentResponse()),
    );
    invalidControl.cards[0]!.breakdowns!.control.components[0]!.binding = false;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(invalidControl)).toThrow(
      /binding controls must reconcile/,
    );
  });

  it("requires explicit bounded causality for D and measured causality for F", () => {
    const bounded = structuredClone(
      SafetyScoreV9CurrentResponseSchema.parse(currentResponse()),
    );
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
    expect(SafetyScoreV9CurrentResponseSchema.parse(bounded).cards[0]?.grade).toBe("D");

    const unownedBoundedTrace = structuredClone(bounded);
    unownedBoundedTrace.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount = 0;
    unownedBoundedTrace.cards[0]!.scoreTrace.evidenceResponsibility.summaries[0] = {
      responsibility: "integration-missing",
      factCount: 0,
      criticalFactCount: 0,
      reasonCodes: [],
    };
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(unownedBoundedTrace)).toThrow(
      /bounded-uncertainty attribution must reconcile/,
    );

    const unboundedCode = structuredClone(bounded);
    unboundedCode.cards[0]!.scoreTrace.boundedUncertaintyAttribution.items[0]!.code =
      "missing-access-review";
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(unboundedCode)).toThrow(
      /policy-bounded reason code/,
    );

    const forgedParent = structuredClone(bounded);
    forgedParent.cards[0]!.scoreTrace.boundedUncertaintyAttribution.items = [{
      source: "parent-score",
      code: "bounded-mechanism-review",
      path: "parent:ghost:backing:mechanism",
      message: "Required parent ghost: A bounded backing review remains unresolved.",
      responsibility: "integration-missing",
    }];
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(forgedParent)).toThrow(
      /binding low minimum serial parent/,
    );

    const forgedPeg = structuredClone(bounded);
    forgedPeg.cards[0]!.scoreTrace.adverseAttribution.items = [{
      source: "peg-performance",
      path: "peg:historical-performance",
      message: "Measured peg multiplier is 0.1.",
      responsibility: "measured-adverse",
    }];
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(forgedPeg)).toThrow(
      /match the measured danger multiplier/,
    );

    const impossibleTrackRecord = structuredClone(bounded);
    impossibleTrackRecord.cards[0]!.scoreTrace.adverseAttribution.items = [{
      source: "track-record",
      path: "track-record:<6m",
      message: "Track record is short.",
      responsibility: "measured-adverse",
    }];
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(impossibleTrackRecord)).toThrow(
      /cannot authorize measured-adverse attribution/,
    );

    const contradictoryReason = structuredClone(bounded);
    contradictoryReason.cards[0]!.scoreTrace.adverseAttribution.items = [{
      source: "reason",
      path: "backing:mechanism",
      message: "A bounded backing review remains unresolved.",
      responsibility: "measured-adverse",
    }];
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(contradictoryReason)).toThrow(
      /cannot also be declared as bounded uncertainty/,
    );

    const unownedMeasuredReason = structuredClone(contradictoryReason);
    unownedMeasuredReason.cards[0]!.scoreTrace.boundedUncertaintyAttribution.items = [];
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(unownedMeasuredReason)).toThrow(
      /must reconcile to a measured-adverse evidence reason code/,
    );

    const reclassifiedBoundedReason = structuredClone(unownedMeasuredReason);
    reclassifiedBoundedReason.cards[0]!.scoreTrace.evidenceResponsibility.summaries[0] = {
      responsibility: "integration-missing",
      factCount: 0,
      criticalFactCount: 0,
      reasonCodes: [],
    };
    reclassifiedBoundedReason.cards[0]!.scoreTrace.evidenceResponsibility.summaries[2] = {
      responsibility: "measured-adverse",
      factCount: 1,
      criticalFactCount: 0,
      reasonCodes: ["bounded-mechanism-review"],
    };
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(reclassifiedBoundedReason)).toThrow(
      /requires a non-bounded policy reason code/,
    );

    const higherParent = structuredClone(bounded.cards[0]!);
    higherParent.score = 40;
    higherParent.grade = "D";
    higherParent.caps = [{
      kind: "parent",
      limit: 40,
      source: "parent",
      reason: "A child cannot rate above its required parent.",
      binding: true,
    }];
    higherParent.bindingCap = higherParent.caps[0]!;
    higherParent.dependencies.serial = [
      { upstreamAssetId: "higher", score: 45, blocked: false },
      { upstreamAssetId: "lower", score: 40, blocked: false },
    ];
    higherParent.scoreTrace.stages.publishedScore = 40;
    higherParent.scoreTrace.adverseAttribution.items = [{
      source: "parent-score",
      path: "parent:higher:structural:centralized-mint:high",
      message: "Required parent higher: Economically effective minting is unbounded.",
      responsibility: "measured-adverse",
    }];
    higherParent.scoreTrace.boundedUncertaintyAttribution.items = [];
    expect(() => SafetyScoreV9CurrentCardSchema.parse(higherParent)).toThrow(
      /binding low minimum serial parent/,
    );

    const tiedParent = structuredClone(higherParent);
    tiedParent.dependencies.serial[0]!.score = 40;
    expect(SafetyScoreV9CurrentCardSchema.parse(tiedParent).grade).toBe("D");

    const cycleBlockedParent = structuredClone(tiedParent);
    cycleBlockedParent.dependencies.cycleBlocked = true;
    expect(() => SafetyScoreV9CurrentCardSchema.parse(cycleBlockedParent)).toThrow(
      /binding parent cap must reconcile/,
    );

    const unattributedD = structuredClone(bounded);
    unattributedD.cards[0]!.scoreTrace.boundedUncertaintyAttribution.items = [];
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(unattributedD)).toThrow(
      /D card requires causal measured-adverse or bounded-uncertainty attribution/,
    );

    const unattributedDanger = structuredClone(bounded);
    unattributedDanger.cards[0]!.score = 35;
    unattributedDanger.cards[0]!.grade = "F";
    unattributedDanger.cards[0]!.scoreTrace.stages.publishedScore = 35;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(unattributedDanger)).toThrow(
      /F card requires causal measured-adverse attribution/,
    );

    const forgedGrade = structuredClone(bounded);
    forgedGrade.cards[0]!.grade = "C-";
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(forgedGrade)).toThrow(
      /numeric score and grade band must agree/,
    );

    const ratedCritical = structuredClone(bounded);
    ratedCritical.cards[0]!.scoreTrace.evidenceResponsibility.summaries[0]!.criticalFactCount = 1;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(ratedCritical)).toThrow(
      /cannot retain critical unresolved facts/,
    );
  });

  it("reconciles every score adjustment to its ordinary score and relieved card cap", () => {
    const valid = adjustedResponse();
    expect(SafetyScoreV9CurrentResponseSchema.parse(valid).cards[0]?.score).toBe(94);

    const missingCap = adjustedResponse();
    missingCap.cards[0]!.caps = missingCap.cards[0]!.caps.filter(
      (cap) => cap.source !== "structural",
    );
    missingCap.cards[0]!.bindingCap = null;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(missingCap)).toThrow(
      /cap relief must match exactly one current card cap/,
    );

    const impossibleOrdinaryScore = adjustedResponse();
    impossibleOrdinaryScore.cards[0]!.scoreTrace.scoreAdjustments[0]!.publishedScoreBefore = 95;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(impossibleOrdinaryScore)).toThrow(
      /permitted rounding headroom/,
    );

    const fictionalRelief = adjustedResponse();
    fictionalRelief.cards[0]!.scoreTrace.scoreAdjustments[0]!.capRelief.kind =
      "signal:unsafe-backing:low";
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(fictionalRelief)).toThrow(
      /cap relief must match exactly one current card cap/,
    );
  });

  it("does not permit the legacy candidate lifecycle on current V9", () => {
    const invalid = currentResponse() as Record<string, unknown>;
    invalid.lifecycle = "candidate";
    invalid.policyVersion = "candidate-v1";
    expect(() => SafetyScoreV9ResponseSchema.parse(invalid)).toThrow();
  });

  it("requires null scores to agree with NR membership and reasons", () => {
    const invalid = structuredClone(response());
    Object.assign(invalid.cards[0], { score: null });
    expect(() => SafetyScoreV9ResponseSchema.parse(invalid)).toThrow(/NR grade and null score must agree/);
  });

  it("requires binding-cap and access-unknown summaries to be exact", () => {
    const invalidCap = structuredClone(response());
    Object.assign(invalidCap.cards[0], { bindingCap: null });
    expect(() => SafetyScoreV9ResponseSchema.parse(invalidCap)).toThrow(/binding cap must match/);

    const invalidAccess = structuredClone(response());
    Object.assign(invalidAccess.cards[0].accessPosture, { governance: "unknown", unknownFields: [] });
    expect(() => SafetyScoreV9ResponseSchema.parse(invalidAccess)).toThrow(/unknown fields must exactly match/);
  });
});
