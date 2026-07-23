import { describe, expect, it } from "vitest";
import { sha256Hex } from "../sha256";
import {
  computeV9HoldoutOutcomeSetDigest,
  createV9ReleaseCandidateSeal,
  evaluateV9HistoricalHoldout,
  verifyV9HistoricalHoldoutValidationReportDigest,
  verifyV9ReleaseCandidateSealDigest,
} from "../safety-score-v9/validation";
import {
  V9_HOLDOUT_VALIDATION_THRESHOLDS,
  V9HistoricalHoldoutValidationReportSchema,
  V9ReleaseCandidateSealPayloadSchema,
  type V9HistoricalHoldoutEvaluationInput,
  type V9HoldoutCaseEvaluation,
  type V9HoldoutCaseManifestEntry,
  type V9HoldoutMatchedPairManifestEntry,
  type V9ReleaseCandidateSealPayload,
} from "../../types/safety-score-v9-validation";
import type { MechanismArchetype } from "../../types/stablecoin-taxonomy";

const ARCHETYPES = ["fiat-cash", "tbill", "cdp", "synthetic-delta-neutral"] as const;
const FAILURE_FAMILIES = ["backing-loss", "exit-failure", "control-compromise"] as const;

function digest(value: string): string {
  return sha256Hex(`safety-score-v9-validation-test:${value}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function caseId(kind: "a" | "r", ordinal: number): string {
  return `case-${kind}-${String(ordinal).padStart(2, "0")}`;
}

function stratum(ordinal: number): { archetype: MechanismArchetype; failurePathFamily: string } {
  return {
    archetype: ARCHETYPES[(ordinal - 1) % ARCHETYPES.length],
    failurePathFamily: FAILURE_FAMILIES[(ordinal - 1) % FAILURE_FAMILIES.length],
  };
}

function manifestCase(kind: "a" | "r", ordinal: number): V9HoldoutCaseManifestEntry {
  const id = caseId(kind, ordinal);
  return {
    caseId: id,
    ...stratum(ordinal),
    clusterId: `cluster-${kind}-${String(ordinal).padStart(2, "0")}`,
    evidenceCutoff: "2025-12-01T00:00:00.000Z",
    factDigest: digest(`${id}:facts`),
    sourceDigest: digest(`${id}:sources`),
    factReviewerIds: ["fact-reviewer-a", "fact-reviewer-b"],
  };
}

function matchedPair(ordinal: number): V9HoldoutMatchedPairManifestEntry {
  return {
    pairId: `pair-${String(ordinal).padStart(2, "0")}`,
    caseIds: [caseId("a", ordinal), caseId("r", ordinal)],
    ...stratum(ordinal),
  };
}

function sealPayload(): V9ReleaseCandidateSealPayload {
  return {
    schemaVersion: 1,
    releaseCandidateId: "v9-rc-1",
    methodologyRoundId: "v9-round-1",
    holdoutId: "v9-independent-holdout-1",
    lifecycle: "sealed-candidate",
    sealedAt: "2026-01-01T00:00:00.000Z",
    sealedBy: "release-owner",
    outcomeAccess: "withheld",
    digests: {
      factSetDigest: digest("fact-set"),
      sourceArchiveDigest: digest("source-archive"),
      policySemanticDigest: digest("policy"),
      evaluationBuildDigest: digest("evaluation-build"),
      holdoutManifestDigest: digest("holdout-manifest"),
      preregistrationDigest: digest("preregistration"),
      outcomeCommitmentDigest: digest("outcomes"),
    },
    thresholds: V9_HOLDOUT_VALIDATION_THRESHOLDS,
    attemptBudget: {
      maximumAttempts: 1,
      attemptNumber: 1,
      attemptsUsedBeforeSeal: 0,
      priorAttemptIds: [],
      sequentialTestingRule: "one-shot-no-holdout-reuse",
    },
    prerequisites: {
      producerCapabilityFreeze: "passed",
      developmentStabilityGate: "passed",
      sourceRetrievalAudit: "passed",
      factAbstractionReliabilityAudit: "passed",
    },
    reviewers: {
      selectionOwnerId: "selection-owner",
      calibrationOwnerIds: ["calibration-owner"],
      outcomeReviewerIds: ["outcome-reviewer"],
      unsealAuthorityIds: ["unseal-authority"],
    },
    cases: [
      ...Array.from({ length: 12 }, (_, index) => manifestCase("a", index + 1)),
      ...Array.from({ length: 12 }, (_, index) => manifestCase("r", index + 1)),
    ],
    matchedPairs: Array.from({ length: 8 }, (_, index) => matchedPair(index + 1)),
  };
}

function evaluatedCase(manifest: V9HoldoutCaseManifestEntry): V9HoldoutCaseEvaluation {
  const adverse = manifest.caseId.startsWith("case-a-");
  const ordinal = Number(manifest.caseId.slice(-2));
  return {
    caseId: manifest.caseId,
    factDigest: manifest.factDigest,
    sourceDigest: manifest.sourceDigest,
    resultDigest: digest(`${manifest.caseId}:result`),
    score: adverse ? 30 + ordinal : 74 + ordinal,
    notRatedReasons: [],
    outcome: {
      classification: adverse ? "adverse" : "stress-exposed-resilient",
      catastrophicOrClaimImpairing: adverse && ordinal <= 2,
      comparableStressVerified: true,
      stressFamily: manifest.failurePathFamily,
      observedFrom: "2026-01-02T00:00:00.000Z",
      observedThrough: "2026-02-01T00:00:00.000Z",
      outcomeReviewerId: "outcome-reviewer",
      censorReason: null,
    },
  };
}

function passingInput(): V9HistoricalHoldoutEvaluationInput {
  const payload = sealPayload();
  const cases = payload.cases.map(evaluatedCase);
  payload.digests.outcomeCommitmentDigest = computeV9HoldoutOutcomeSetDigest(cases);
  const seal = createV9ReleaseCandidateSeal(payload);
  return {
    schemaVersion: 1,
    evaluatedAt: "2026-02-02T00:00:00.000Z",
    seal,
    bindings: {
      factSetDigest: seal.digests.factSetDigest,
      sourceArchiveDigest: seal.digests.sourceArchiveDigest,
      policySemanticDigest: seal.digests.policySemanticDigest,
      evaluationBuildDigest: seal.digests.evaluationBuildDigest,
      holdoutManifestDigest: seal.digests.holdoutManifestDigest,
    },
    unseal: {
      eventId: "unseal-event-1",
      releaseCandidateId: seal.releaseCandidateId,
      holdoutId: seal.holdoutId,
      sealDigest: seal.sealDigest,
      outcomeSetDigest: seal.digests.outcomeCommitmentDigest,
      unsealedAt: "2026-01-02T00:00:00.000Z",
      authorizedBy: "unseal-authority",
      attemptNumber: 1,
      priorUnsealEventCount: 0,
      outcomeAccessBeforeEvent: "withheld",
      outcomeAccessAfterEvent: "unsealed",
    },
    cases,
  };
}

function markNotRated(entry: V9HoldoutCaseEvaluation): void {
  entry.score = null;
  entry.notRatedReasons = ["critical-evidence-missing"];
}

describe("Safety Score v9 independent holdout validation", () => {
  it("creates a deterministic, self-verifying release-candidate seal", () => {
    const payload = sealPayload();
    const first = createV9ReleaseCandidateSeal(payload);
    const second = createV9ReleaseCandidateSeal(clone(payload));

    expect(first).toEqual(second);
    expect(verifyV9ReleaseCandidateSealDigest(first)).toBe(true);
    expect(
      V9ReleaseCandidateSealPayloadSchema.safeParse({ ...payload, unregisteredThresholdOverride: 75 }).success,
    ).toBe(false);
    expect(
      V9ReleaseCandidateSealPayloadSchema.safeParse({
        ...payload,
        thresholds: { ...payload.thresholds, minimumClassRateabilityBps: 7_999 },
      }).success,
    ).toBe(false);
  });

  it("passes a fully bound 12/12 synthetic protocol exercise without making a statistical claim", () => {
    const report = evaluateV9HistoricalHoldout(passingInput());

    expect(V9HistoricalHoldoutValidationReportSchema.parse(report)).toEqual(report);
    expect(report.decision).toBe("gate-passed");
    expect(report.noGoReasons).toEqual([]);
    expect(report.claimScope).toBe("diverse-release-regression-not-an-error-rate-estimate");
    expect(report.corpus).toMatchObject({ registeredCases: 24, adverseCases: 12, resilientCases: 12 });
    expect(report.rateability.adverse.rateabilityBps).toBe(10_000);
    expect(report.separation.medianGap).toBeGreaterThanOrEqual(15);
    expect(report.matchedPairs).toMatchObject({ registered: 8, passing: 8, orderingBps: 10_000 });
    expect(verifyV9HistoricalHoldoutValidationReportDigest(report)).toBe(true);

    const tampered = clone(report);
    tampered.separation.medianGap = tampered.separation.medianGap! + 1;
    expect(verifyV9HistoricalHoldoutValidationReportDigest(tampered)).toBe(false);
  });

  it("commits exact outcome, score, and result payloads independent of case order", () => {
    const input = passingInput();
    expect(computeV9HoldoutOutcomeSetDigest([...input.cases].reverse())).toBe(input.unseal.outcomeSetDigest);

    for (const mutate of [
      (candidate: V9HistoricalHoldoutEvaluationInput) => {
        candidate.cases[0]!.outcome.observedThrough = "2026-02-02T00:00:00.000Z";
      },
      (candidate: V9HistoricalHoldoutEvaluationInput) => {
        candidate.cases[0]!.score = candidate.cases[0]!.score! + 1;
      },
      (candidate: V9HistoricalHoldoutEvaluationInput) => {
        candidate.cases[0]!.resultDigest = digest("mutated-result");
      },
    ]) {
      const candidate = clone(input);
      mutate(candidate);
      const report = evaluateV9HistoricalHoldout(candidate);
      expect(report.bindings.outcomeCommitmentDigest).toBe(false);
      expect(report.noGoReasons).toContain("outcome-commitment-digest-mismatch");
      expect(report.digests.outcomeSetDigest).toBe(computeV9HoldoutOutcomeSetDigest(candidate.cases));
    }
  });

  it("reports minimum corpus and class failures instead of refusing to preserve a failed seal", () => {
    const input = passingInput();
    const payload = sealPayload();
    payload.cases = payload.cases.filter((entry) => entry.caseId !== "case-r-12");
    input.seal = createV9ReleaseCandidateSeal(payload);
    input.unseal.sealDigest = input.seal.sealDigest;
    input.cases = input.seal.cases.map(evaluatedCase);

    const report = evaluateV9HistoricalHoldout(input);
    expect(report.decision).toBe("no-go");
    expect(report.noGoReasons).toContain("case-count-below-24");
    expect(report.noGoReasons).toContain("resilient-count-below-12");
  });

  it("uses explicit adverse and resilient rateability denominators", () => {
    const input = passingInput();
    for (const id of ["case-r-09", "case-r-10", "case-r-11"]) {
      markNotRated(input.cases.find((entry) => entry.caseId === id)!);
    }

    const report = evaluateV9HistoricalHoldout(input);
    expect(report.rateability.resilient).toEqual({
      denominator: 12,
      rated: 9,
      notRated: 3,
      rateabilityBps: 7_500,
    });
    expect(report.noGoReasons).toContain("resilient-rateability-below-80-percent");
  });

  it("counts NR matched-pair members as failed pairs rather than removing them", () => {
    const input = passingInput();
    markNotRated(input.cases.find((entry) => entry.caseId === "case-r-01")!);
    markNotRated(input.cases.find((entry) => entry.caseId === "case-r-02")!);

    const report = evaluateV9HistoricalHoldout(input);
    expect(report.rateability.resilient.rateabilityBps).toBe(8_333);
    expect(report.matchedPairs).toMatchObject({ registered: 8, passing: 6, notRated: 2, orderingBps: 7_500 });
    expect(report.noGoReasons).not.toContain("resilient-rateability-below-80-percent");
    expect(report.noGoReasons).toContain("matched-pair-ordering-below-80-percent");
  });

  it("enforces the absolute adverse and resilient anchors", () => {
    const input = passingInput();
    input.cases.find((entry) => entry.caseId === "case-a-01")!.score = 50;
    input.cases.find((entry) => entry.caseId === "case-a-03")!.score = 70;
    for (const id of ["case-r-01", "case-r-02", "case-r-03"]) {
      input.cases.find((entry) => entry.caseId === id)!.score = 49;
    }

    const report = evaluateV9HistoricalHoldout(input);
    expect(report.absoluteAnchors).toMatchObject({
      catastrophicAdverseCases: 2,
      catastrophicAdversePassing: 1,
      adverseAtOrAbove70: 1,
      resilientBelow50: 3,
      resilientBelow50Bps: 2_500,
    });
    expect(report.noGoReasons).toContain("catastrophic-adverse-score-not-below-50");
    expect(report.noGoReasons).toContain("adverse-score-at-or-above-70");
    expect(report.noGoReasons).toContain("resilient-below-50-rate-above-20-percent");
  });

  it("fails closed on seal, evaluation-build, outcome commitment, and one-shot governance drift", () => {
    const input = passingInput();
    input.seal.sealDigest = digest("tampered-seal");
    input.unseal.sealDigest = input.seal.sealDigest;
    input.bindings.evaluationBuildDigest = digest("wrong-build");
    input.unseal.outcomeSetDigest = digest("wrong-outcomes");
    input.unseal.attemptNumber = 2;
    input.unseal.priorUnsealEventCount = 1;
    input.unseal.authorizedBy = "unknown-authority";

    const report = evaluateV9HistoricalHoldout(input);
    expect(report.noGoReasons).toEqual(
      expect.arrayContaining([
        "candidate-seal-digest-mismatch",
        "evaluation-build-digest-mismatch",
        "outcome-commitment-digest-mismatch",
        "unseal-attempt-budget-violated",
        "unseal-event-repeated",
        "unseal-authority-not-registered",
      ]),
    );
  });

  it("keeps fact and outcome reviewer roles independent", () => {
    const input = passingInput();
    const { sealDigest: _sealDigest, ...payload } = input.seal;
    payload.reviewers.outcomeReviewerIds = ["fact-reviewer-a"];
    input.seal = createV9ReleaseCandidateSeal(payload);
    input.unseal.sealDigest = input.seal.sealDigest;
    input.cases.forEach((entry) => {
      entry.outcome.outcomeReviewerId = "fact-reviewer-a";
    });

    const report = evaluateV9HistoricalHoldout(input);
    expect(report.governance.reviewerIndependence).toBe(false);
    expect(report.noGoReasons).toContain("reviewer-independence-failed");
  });

  it("requires preregistered source, reliability, development, and producer gates", () => {
    const input = passingInput();
    const { sealDigest: _sealDigest, ...payload } = input.seal;
    payload.prerequisites = {
      producerCapabilityFreeze: "not-run",
      developmentStabilityGate: "failed",
      sourceRetrievalAudit: "not-run",
      factAbstractionReliabilityAudit: "failed",
    };
    input.seal = createV9ReleaseCandidateSeal(payload);
    input.unseal.sealDigest = input.seal.sealDigest;

    const report = evaluateV9HistoricalHoldout(input);
    expect(report.governance.prerequisitesPassed).toBe(false);
    expect(report.noGoReasons).toEqual(
      expect.arrayContaining([
        "producer-capability-freeze-incomplete",
        "development-stability-gate-incomplete",
        "source-retrieval-audit-incomplete",
        "fact-abstraction-reliability-incomplete",
      ]),
    );
  });
});
