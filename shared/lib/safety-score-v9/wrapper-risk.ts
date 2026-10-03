import {
  V9_WRAPPER_LOCAL_FACT_KEYS,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperFactDisposition,
  type V9WrapperForm,
  type V9WrapperLocalFactKey,
  type V9WrapperRiskAssessment,
} from "../../types/safety-score-v9-wrapper";
import { round4 } from "../math";
import { assertScore, compareText } from "./primitives";
import type { V9FactGapV3, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import type { V9EvidenceCause, V9ScoringDisposition } from "../../types/safety-score-v9-causes";
import { resolveV9StatusCauses, v9ScoringDisposition } from "./control-primitives";

export type { V9WrapperForm } from "../../types/safety-score-v9-wrapper";

export type V9WrapperMissingFactClass = V9WrapperLocalFactKey | "riskTransfer" | "wrapperForm";

export interface V9WrapperParentLimitInput {
  parentScore: number;
  localFacts: V9ApplicableWrapperLocalFacts;
  fallbackDiscounts: Readonly<Record<V9WrapperForm, number>>;
  gaps?: readonly V9FactGapV3[];
}

export interface V9WrapperLocalRiskAdjustment {
  factKey: V9WrapperLocalFactKey;
  disposition: V9WrapperFactDisposition;
  assessment: V9WrapperRiskAssessment | null;
  maximumDiscountPoints: number;
  discountPoints: number;
  cause: V9EvidenceCause | null;
  causeGapIds: readonly string[];
  scoringDisposition: V9ScoringDisposition;
}

export interface V9WrapperMissingFact {
  factClass: V9WrapperMissingFactClass;
  disposition: Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable">;
  cause: V9EvidenceCause;
  causeGapIds: readonly string[];
  scoringDisposition: V9ScoringDisposition;
}

export interface V9WrapperParentLimit {
  schemaVersion: 1;
  parentScore: number;
  form: V9WrapperForm;
  treatment: "local-facts" | "fallback-discount" | "documented-risk-transfer";
  localRiskDiscount: number;
  fallbackDiscount: number;
  appliedDiscount: number;
  riskTransfer: {
    disposition: V9WrapperFactDisposition;
    mechanism: V9ApplicableWrapperLocalFacts["riskTransfer"]["mechanism"];
    requestedCredit: number;
    appliedCredit: number;
  };
  limit: number;
  factsComplete: boolean;
  missingFacts: readonly V9WrapperMissingFact[];
  adjustments: readonly V9WrapperLocalRiskAdjustment[];
}

const MAXIMUM_DISCOUNT_POINTS = {
  contractMutability: 2,
  custodyEscrow: 2,
  strategyComplexity: 2,
  leverage: 4,
  rehypothecationCorrelation: 3,
  shareAccountingNavOracle: 2,
  withdrawalTerms: 3,
  measuredUnwind: 5,
  lossAbsorptionEmergencyControls: 4,
} as const satisfies Readonly<Record<V9WrapperLocalFactKey, number>>;

const ASSESSMENT_MULTIPLIER = {
  none: 0,
  low: 0.1,
  moderate: 0.35,
  high: 0.7,
  critical: 1,
} as const satisfies Readonly<Record<V9WrapperRiskAssessment, number>>;

function effectiveAssessment(
  factKey: V9WrapperLocalFactKey,
  fact: V9ApplicableWrapperLocalFacts["facts"][V9WrapperLocalFactKey],
): V9WrapperRiskAssessment | null {
  const assessments: V9WrapperRiskAssessment[] =
    fact.disposition === "reviewed" && fact.assessment !== null ? [fact.assessment] : [];
  for (const posture of fact.incidentPostures ?? []) {
    // `measuredUnwind` is the wrapper holder's unwind dimension. A loss or
    // forced unwind confined to an external integration remains reviewed
    // evidence, but cannot be relabelled as root-holder impairment. The
    // share-accounting dimension remains eligible because integration misuse
    // can still measure the wrapper's composability posture.
    if (factKey === "measuredUnwind" && posture.scope.kind === "integration-only") continue;
    assessments.push(posture.assessment);
  }
  return assessments.sort(
    (left, right) => ASSESSMENT_MULTIPLIER[right] - ASSESSMENT_MULTIPLIER[left],
  )[0] ?? null;
}

function unavailableDisposition(
  disposition: V9WrapperFactDisposition,
): disposition is Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable"> {
  return disposition !== "reviewed" && disposition !== "not-applicable";
}

/**
 * Apply serial parent risk exactly once, then price only the wrapper's local
 * layer. Fixed form discounts are fail-closed substitutes for incomplete
 * local facts, never an additional haircut on a complete review.
 */
export function resolveV9WrapperParentLimit(input: V9WrapperParentLimitInput): V9WrapperParentLimit {
  assertScore(input.parentScore, "wrapper parent score");
  const form = input.localFacts.form;
  const configuredFallbackDiscount = input.fallbackDiscounts[form];
  if (
    !Number.isFinite(configuredFallbackDiscount) ||
    configuredFallbackDiscount < 0 ||
    configuredFallbackDiscount > 100
  ) {
    throw new Error("Safety Score v9 wrapper fallback discount must be between 0 and 100");
  }

  const missingCause = (status?: V9FactStatusV2) => {
    const resolved = resolveV9StatusCauses([status], input.gaps);
    return { cause: resolved.cause ?? "U", causeGapIds: resolved.causeGapIds,
      scoringDisposition: v9ScoringDisposition(resolved.cause ?? "U") };
  };
  const adjustments = V9_WRAPPER_LOCAL_FACT_KEYS.map((factKey): V9WrapperLocalRiskAdjustment => {
    const fact = input.localFacts.facts[factKey];
    const maximumDiscountPoints = MAXIMUM_DISCOUNT_POINTS[factKey];
    const assessment = effectiveAssessment(factKey, fact);
    const discountPoints =
      assessment !== null
        ? round4(maximumDiscountPoints * ASSESSMENT_MULTIPLIER[assessment])
        : 0;
    const causal = discountPoints > 0 && fact.signals.some((signal) => signal === "active-incident" || signal === "prior-incident")
      ? { cause: "D" as const, causeGapIds: [], scoringDisposition: "measured-adverse" as const }
      : assessment === null && unavailableDisposition(fact.disposition) ? missingCause(fact.status)
        : { cause: null, causeGapIds: [], scoringDisposition: "included" as const };
    return {
      factKey,
      disposition: fact.disposition,
      assessment,
      maximumDiscountPoints,
      discountPoints,
      ...causal,
    };
  });
  const missingFacts: V9WrapperMissingFact[] = adjustments.flatMap((adjustment) =>
    unavailableDisposition(adjustment.disposition)
      ? [{ factClass: adjustment.factKey, disposition: adjustment.disposition, ...missingCause(input.localFacts.facts[adjustment.factKey].status) }]
      : [],
  );
  if (unavailableDisposition(input.localFacts.formDisposition)) {
    missingFacts.push({ factClass: "wrapperForm", disposition: input.localFacts.formDisposition, ...missingCause(input.localFacts.formStatus) });
  }
  if (unavailableDisposition(input.localFacts.riskTransfer.disposition)) {
    missingFacts.push({ factClass: "riskTransfer", disposition: input.localFacts.riskTransfer.disposition, ...missingCause(input.localFacts.riskTransfer.status) });
  }
  missingFacts.sort(
    (left, right) =>
      compareText(left.factClass, right.factClass) ||
      compareText(left.disposition, right.disposition),
  );

  const localRiskDiscount = round4(
    adjustments.reduce((sum, adjustment) => sum + adjustment.discountPoints, 0),
  );
  const factsComplete = missingFacts.length === 0;
  // Proven A/B gaps are not local loss. C/U withdrawal uncertainty retains
  // the form fallback; measured-unwind uncertainty alone remains exempt.
  const fallbackRequired = missingFacts.some(
    (fact) =>
      fact.cause !== "A" && fact.cause !== "B" &&
      fact.factClass !== "measuredUnwind" &&
      (fact.factClass !== "withdrawalTerms" ||
        fact.cause === "C" || fact.cause === "U" || fact.disposition === "issuer-undisclosed"),
  );
  const fallbackDiscount = fallbackRequired ? configuredFallbackDiscount : 0;
  const appliedDiscount = round4(Math.max(localRiskDiscount, fallbackDiscount));

  const requestedCredit =
    factsComplete &&
    input.localFacts.riskTransfer.disposition === "reviewed" &&
    input.localFacts.riskTransfer.mechanism !== "none"
      ? input.localFacts.riskTransfer.maximumParentLossAbsorptionPoints
      : 0;
  assertScore(requestedCredit, "wrapper risk-transfer credit");
  const scoreBeforeCredit = Math.max(0, input.parentScore - appliedDiscount);
  const appliedCredit = round4(Math.min(requestedCredit, 100 - scoreBeforeCredit));
  const limit = round4(scoreBeforeCredit + appliedCredit);

  return {
    schemaVersion: 1,
    parentScore: input.parentScore,
    form,
    treatment:
      appliedCredit > 0
        ? "documented-risk-transfer"
        : fallbackDiscount === 0
          ? "local-facts"
          : "fallback-discount",
    localRiskDiscount,
    fallbackDiscount,
    appliedDiscount,
    riskTransfer: {
      disposition: input.localFacts.riskTransfer.disposition,
      mechanism: input.localFacts.riskTransfer.mechanism,
      requestedCredit,
      appliedCredit,
    },
    limit,
    factsComplete,
    missingFacts,
    adjustments,
  };
}
