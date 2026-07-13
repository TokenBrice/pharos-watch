import {
  V9HistoricalHoldoutEvaluationInputSchema,
  V9HistoricalHoldoutValidationReportSchema,
  V9HoldoutOutcomeSetCommitmentPayloadSchema,
  V9ReleaseCandidateSealPayloadSchema,
  V9ReleaseCandidateSealSchema,
  type V9HistoricalHoldoutEvaluationInput,
  type V9HistoricalHoldoutValidationReport,
  type V9HoldoutCaseEvaluation,
  type V9HoldoutNoGoReasonCode,
  type V9ReleaseCandidateSeal,
  type V9ReleaseCandidateSealPayload,
} from "../../types/safety-score-v9-validation";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

const V9_RELEASE_CANDIDATE_SEAL_DIGEST_DOMAIN = "safety-score-v9.release-candidate-seal.v1";
const V9_HOLDOUT_VALIDATION_REPORT_DIGEST_DOMAIN = "safety-score-v9.holdout-validation-report.v1";
const V9_HOLDOUT_OUTCOME_SET_DIGEST_DOMAIN = "safety-score-v9.holdout-outcome-set.v1";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sealPayload(seal: V9ReleaseCandidateSeal): V9ReleaseCandidateSealPayload {
  const { sealDigest: _sealDigest, ...payload } = seal;
  return V9ReleaseCandidateSealPayloadSchema.parse(payload);
}

function computeV9ReleaseCandidateSealDigest(payload: V9ReleaseCandidateSealPayload): string {
  const parsed = V9ReleaseCandidateSealPayloadSchema.parse(payload);
  return sha256Hex(
    stableJsonStringifyV1({ domain: V9_RELEASE_CANDIDATE_SEAL_DIGEST_DOMAIN, releaseCandidate: parsed }),
  );
}

export function createV9ReleaseCandidateSeal(payload: V9ReleaseCandidateSealPayload): V9ReleaseCandidateSeal {
  const parsed = V9ReleaseCandidateSealPayloadSchema.parse(payload);
  return V9ReleaseCandidateSealSchema.parse({
    ...parsed,
    sealDigest: computeV9ReleaseCandidateSealDigest(parsed),
  });
}

export function verifyV9ReleaseCandidateSealDigest(seal: V9ReleaseCandidateSeal): boolean {
  const parsed = V9ReleaseCandidateSealSchema.parse(seal);
  return parsed.sealDigest === computeV9ReleaseCandidateSealDigest(sealPayload(parsed));
}

/** Commit to the exact reviewed outcomes and scorer results, independent of input array order. */
export function computeV9HoldoutOutcomeSetDigest(cases: readonly V9HoldoutCaseEvaluation[]): string {
  const payload = V9HoldoutOutcomeSetCommitmentPayloadSchema.parse({
    schemaVersion: 1,
    cases: cases
      .map((entry) => ({
        caseId: entry.caseId,
        resultDigest: entry.resultDigest,
        score: entry.score,
        notRatedReasons: entry.notRatedReasons,
        outcome: entry.outcome,
      }))
      .sort((left, right) => compareText(left.caseId, right.caseId)),
  });
  return sha256Hex(stableJsonStringifyV1({ domain: V9_HOLDOUT_OUTCOME_SET_DIGEST_DOMAIN, outcomeSet: payload }));
}

function ratioBps(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.floor((numerator * 10_000) / denominator);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function classRateability(cases: readonly V9HoldoutCaseEvaluation[]) {
  const rated = cases.filter((entry) => entry.score !== null).length;
  return {
    denominator: cases.length,
    rated,
    notRated: cases.length - rated,
    rateabilityBps: ratioBps(rated, cases.length),
  };
}

function hasMinimumRatio(numerator: number, denominator: number, minimumBps: number): boolean {
  return denominator > 0 && numerator * 10_000 >= denominator * minimumBps;
}

function exceedsMaximumRatio(numerator: number, denominator: number, maximumBps: number): boolean {
  return denominator > 0 && numerator * 10_000 > denominator * maximumBps;
}

function prerequisitesPassed(input: V9HistoricalHoldoutEvaluationInput): boolean {
  return Object.values(input.seal.prerequisites).every((status) => status === "passed");
}

function reviewerIndependencePassed(input: V9HistoricalHoldoutEvaluationInput): boolean {
  const factReviewers = new Set(input.seal.cases.flatMap((entry) => entry.factReviewerIds));
  const prohibitedOutcomeReviewers = new Set([
    ...factReviewers,
    input.seal.reviewers.selectionOwnerId,
    ...input.seal.reviewers.calibrationOwnerIds,
  ]);
  const registered = new Set(input.seal.reviewers.outcomeReviewerIds);
  return (
    input.seal.reviewers.outcomeReviewerIds.every((reviewer) => !prohibitedOutcomeReviewers.has(reviewer)) &&
    input.cases.every(
      (entry) =>
        registered.has(entry.outcome.outcomeReviewerId) &&
        !prohibitedOutcomeReviewers.has(entry.outcome.outcomeReviewerId),
    )
  );
}

/** Evaluate the preregistered holdout once. This function neither selects nor mutates cases. */
export function evaluateV9HistoricalHoldout(
  rawInput: V9HistoricalHoldoutEvaluationInput,
): V9HistoricalHoldoutValidationReport {
  const input = V9HistoricalHoldoutEvaluationInputSchema.parse(rawInput);
  const threshold = input.seal.thresholds;
  const expectedSealDigest = computeV9ReleaseCandidateSealDigest(sealPayload(input.seal));
  const manifestById = new Map(input.seal.cases.map((entry) => [entry.caseId, entry]));
  const resultById = new Map(input.cases.map((entry) => [entry.caseId, entry]));
  const manifestIds = input.seal.cases.map((entry) => entry.caseId).sort(compareText);
  const resultIds = input.cases.map((entry) => entry.caseId).sort(compareText);
  const manifestReconciled =
    manifestIds.length === resultIds.length && manifestIds.every((caseId, index) => caseId === resultIds[index]);
  const computedOutcomeSetDigest = computeV9HoldoutOutcomeSetDigest(input.cases);

  const bindingChecks = {
    sealDigest: input.seal.sealDigest === expectedSealDigest && input.unseal.sealDigest === input.seal.sealDigest,
    factSetDigest: input.bindings.factSetDigest === input.seal.digests.factSetDigest,
    sourceArchiveDigest: input.bindings.sourceArchiveDigest === input.seal.digests.sourceArchiveDigest,
    policySemanticDigest: input.bindings.policySemanticDigest === input.seal.digests.policySemanticDigest,
    evaluationBuildDigest: input.bindings.evaluationBuildDigest === input.seal.digests.evaluationBuildDigest,
    holdoutManifestDigest: input.bindings.holdoutManifestDigest === input.seal.digests.holdoutManifestDigest,
    outcomeCommitmentDigest:
      computedOutcomeSetDigest === input.unseal.outcomeSetDigest &&
      computedOutcomeSetDigest === input.seal.digests.outcomeCommitmentDigest,
    caseFactDigests: input.cases.every((entry) => manifestById.get(entry.caseId)?.factDigest === entry.factDigest),
    caseSourceDigests: input.cases.every(
      (entry) => manifestById.get(entry.caseId)?.sourceDigest === entry.sourceDigest,
    ),
  } as const;

  const governance = {
    sealedBeforeUnseal: Date.parse(input.unseal.unsealedAt) > Date.parse(input.seal.sealedAt),
    evaluatedAfterUnseal: Date.parse(input.evaluatedAt) >= Date.parse(input.unseal.unsealedAt),
    oneShotAttemptBudget:
      input.unseal.attemptNumber === input.seal.attemptBudget.attemptNumber &&
      input.unseal.attemptNumber <= input.seal.attemptBudget.maximumAttempts,
    oneTimeUnseal: input.unseal.priorUnsealEventCount === 0,
    registeredUnsealAuthority: input.seal.reviewers.unsealAuthorityIds.includes(input.unseal.authorizedBy),
    reviewerIndependence: reviewerIndependencePassed(input),
    prerequisitesPassed: prerequisitesPassed(input),
  } as const;

  const adverseCases = input.cases.filter((entry) => entry.outcome.classification === "adverse");
  const resilientCases = input.cases.filter((entry) => entry.outcome.classification === "stress-exposed-resilient");
  const censoredCases = input.cases.filter((entry) => entry.outcome.classification === "censored");
  const adverseRateability = classRateability(adverseCases);
  const resilientRateability = classRateability(resilientCases);

  const catastrophicCases = adverseCases.filter((entry) => entry.outcome.catastrophicOrClaimImpairing);
  const catastrophicPassing = catastrophicCases.filter(
    (entry) => entry.score !== null && entry.score < threshold.catastrophicAdverseScoreExclusiveMaximum,
  ).length;
  const adverseAtOrAboveMaximum = adverseCases.filter(
    (entry) => entry.score !== null && entry.score >= threshold.adverseScoreExclusiveMaximum,
  ).length;
  const resilientBelowThreshold = resilientCases.filter(
    (entry) => entry.score !== null && entry.score < threshold.resilientLowScoreThreshold,
  ).length;
  const resilientBelowThresholdBps = ratioBps(resilientBelowThreshold, resilientRateability.rated);

  const adverseMedian = median(adverseCases.flatMap((entry) => (entry.score === null ? [] : [entry.score])));
  const resilientMedian = median(resilientCases.flatMap((entry) => (entry.score === null ? [] : [entry.score])));
  const medianGap = adverseMedian === null || resilientMedian === null ? null : resilientMedian - adverseMedian;

  let passingPairs = 0;
  let notRatedPairs = 0;
  let outcomeClassMismatchPairs = 0;
  for (const pair of input.seal.matchedPairs) {
    const members = pair.caseIds.map((caseId) => resultById.get(caseId));
    const adverse = members.find((entry) => entry?.outcome.classification === "adverse");
    const resilient = members.find((entry) => entry?.outcome.classification === "stress-exposed-resilient");
    if (!adverse || !resilient) {
      outcomeClassMismatchPairs += 1;
      continue;
    }
    if (adverse.score === null || resilient.score === null) {
      notRatedPairs += 1;
      continue;
    }
    if (resilient.score - adverse.score >= threshold.minimumMatchedPairScoreGap) passingPairs += 1;
  }

  const pairArchetypeCount = new Set(input.seal.matchedPairs.map((pair) => pair.archetype)).size;
  const pairFailurePathFamilyCount = new Set(input.seal.matchedPairs.map((pair) => pair.failurePathFamily)).size;
  const pairOrderingBps = ratioBps(passingPairs, input.seal.matchedPairs.length);

  const noGoReasons = new Set<V9HoldoutNoGoReasonCode>();
  const add = (condition: boolean, reason: V9HoldoutNoGoReasonCode): void => {
    if (condition) noGoReasons.add(reason);
  };

  add(!bindingChecks.sealDigest, "candidate-seal-digest-mismatch");
  add(!bindingChecks.factSetDigest, "fact-set-digest-mismatch");
  add(!bindingChecks.sourceArchiveDigest, "source-archive-digest-mismatch");
  add(!bindingChecks.policySemanticDigest, "policy-semantic-digest-mismatch");
  add(!bindingChecks.evaluationBuildDigest, "evaluation-build-digest-mismatch");
  add(!bindingChecks.holdoutManifestDigest, "holdout-manifest-digest-mismatch");
  add(!bindingChecks.outcomeCommitmentDigest, "outcome-commitment-digest-mismatch");
  add(!manifestReconciled, "case-manifest-mismatch");
  add(!bindingChecks.caseFactDigests, "case-fact-digest-mismatch");
  add(!bindingChecks.caseSourceDigests, "case-source-digest-mismatch");
  add(
    input.unseal.releaseCandidateId !== input.seal.releaseCandidateId ||
      input.unseal.holdoutId !== input.seal.holdoutId,
    "unseal-identity-mismatch",
  );
  add(!governance.sealedBeforeUnseal, "unseal-before-seal");
  add(!governance.evaluatedAfterUnseal, "evaluation-before-unseal");
  add(!governance.oneShotAttemptBudget, "unseal-attempt-budget-violated");
  add(!governance.oneTimeUnseal, "unseal-event-repeated");
  add(!governance.registeredUnsealAuthority, "unseal-authority-not-registered");
  add(input.seal.prerequisites.producerCapabilityFreeze !== "passed", "producer-capability-freeze-incomplete");
  add(input.seal.prerequisites.developmentStabilityGate !== "passed", "development-stability-gate-incomplete");
  add(input.seal.prerequisites.sourceRetrievalAudit !== "passed", "source-retrieval-audit-incomplete");
  add(input.seal.prerequisites.factAbstractionReliabilityAudit !== "passed", "fact-abstraction-reliability-incomplete");
  add(!governance.reviewerIndependence, "reviewer-independence-failed");
  add(input.seal.cases.length < threshold.minimumCaseCount, "case-count-below-24");
  add(adverseCases.length < threshold.minimumAdverseCount, "adverse-count-below-12");
  add(resilientCases.length < threshold.minimumResilientCount, "resilient-count-below-12");
  add(
    !hasMinimumRatio(adverseRateability.rated, adverseRateability.denominator, threshold.minimumClassRateabilityBps),
    "adverse-rateability-below-80-percent",
  );
  add(
    !hasMinimumRatio(
      resilientRateability.rated,
      resilientRateability.denominator,
      threshold.minimumClassRateabilityBps,
    ),
    "resilient-rateability-below-80-percent",
  );
  add(
    resilientCases.some((entry) => !entry.outcome.comparableStressVerified),
    "resilient-stress-evidence-incomplete",
  );
  add(catastrophicPassing !== catastrophicCases.length, "catastrophic-adverse-score-not-below-50");
  add(adverseAtOrAboveMaximum > 0, "adverse-score-at-or-above-70");
  add(
    exceedsMaximumRatio(resilientBelowThreshold, resilientRateability.rated, threshold.maximumResilientLowScoreBps),
    "resilient-below-50-rate-above-20-percent",
  );
  add(medianGap === null || medianGap < threshold.minimumMedianSeparation, "median-separation-below-15");
  add(input.seal.matchedPairs.length < threshold.minimumMatchedPairCount, "matched-pair-count-below-8");
  add(pairArchetypeCount < threshold.minimumMatchedPairArchetypeCount, "matched-pair-archetype-coverage-below-4");
  add(
    pairFailurePathFamilyCount < threshold.minimumMatchedPairFailurePathFamilyCount,
    "matched-pair-failure-path-coverage-below-3",
  );
  add(outcomeClassMismatchPairs > 0, "matched-pair-outcome-class-mismatch");
  add(
    !hasMinimumRatio(passingPairs, input.seal.matchedPairs.length, threshold.minimumMatchedPairOrderingBps),
    "matched-pair-ordering-below-80-percent",
  );

  const orderedNoGoReasons = [...noGoReasons].sort(compareText);
  const reportWithoutDigest = {
    schemaVersion: 1 as const,
    releaseCandidateId: input.seal.releaseCandidateId,
    methodologyRoundId: input.seal.methodologyRoundId,
    holdoutId: input.seal.holdoutId,
    sealDigest: input.seal.sealDigest,
    evaluatedAt: input.evaluatedAt,
    claimScope: "diverse-release-regression-not-an-error-rate-estimate" as const,
    decision: orderedNoGoReasons.length === 0 ? ("gate-passed" as const) : ("no-go" as const),
    thresholds: input.seal.thresholds,
    digests: {
      factSetDigest: input.seal.digests.factSetDigest,
      sourceArchiveDigest: input.seal.digests.sourceArchiveDigest,
      policySemanticDigest: input.seal.digests.policySemanticDigest,
      evaluationBuildDigest: input.seal.digests.evaluationBuildDigest,
      holdoutManifestDigest: input.seal.digests.holdoutManifestDigest,
      outcomeSetDigest: computedOutcomeSetDigest,
    },
    bindings: bindingChecks,
    governance,
    corpus: {
      registeredCases: input.seal.cases.length,
      reportedCases: input.cases.length,
      adverseCases: adverseCases.length,
      resilientCases: resilientCases.length,
      censoredCases: censoredCases.length,
      manifestReconciled,
    },
    rateability: { adverse: adverseRateability, resilient: resilientRateability },
    absoluteAnchors: {
      catastrophicAdverseCases: catastrophicCases.length,
      catastrophicAdversePassing: catastrophicPassing,
      adverseAtOrAbove70: adverseAtOrAboveMaximum,
      adverseNotRated: adverseRateability.notRated,
      resilientBelow50: resilientBelowThreshold,
      resilientBelow50Bps: resilientBelowThresholdBps,
    },
    separation: { adverseMedian, resilientMedian, medianGap },
    matchedPairs: {
      registered: input.seal.matchedPairs.length,
      passing: passingPairs,
      notRated: notRatedPairs,
      outcomeClassMismatch: outcomeClassMismatchPairs,
      orderingBps: pairOrderingBps,
      archetypeCount: pairArchetypeCount,
      failurePathFamilyCount: pairFailurePathFamilyCount,
    },
    noGoReasons: orderedNoGoReasons,
  };
  const reportDigest = sha256Hex(
    stableJsonStringifyV1({ domain: V9_HOLDOUT_VALIDATION_REPORT_DIGEST_DOMAIN, report: reportWithoutDigest }),
  );
  return V9HistoricalHoldoutValidationReportSchema.parse({ ...reportWithoutDigest, reportDigest });
}
