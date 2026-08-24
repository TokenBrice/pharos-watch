import {
  V9_WRAPPER_LOCAL_FACT_KEYS,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperFactDisposition,
  type V9WrapperForm,
  type V9WrapperLocalFactKey,
  type V9WrapperRiskAssessment,
} from "../../types/safety-score-v9-wrapper";
import { compareText } from "./primitives";

export type { V9WrapperForm } from "../../types/safety-score-v9-wrapper";

export type V9WrapperMissingFactClass = V9WrapperLocalFactKey | "riskTransfer" | "wrapperForm";

export interface V9WrapperParentLimitInput {
  parentScore: number;
  localFacts: V9ApplicableWrapperLocalFacts;
  fallbackDiscounts: Readonly<Record<V9WrapperForm, number>>;
}

export interface V9WrapperLocalRiskAdjustment {
  factKey: V9WrapperLocalFactKey;
  disposition: V9WrapperFactDisposition;
  assessment: V9WrapperRiskAssessment | null;
  maximumDiscountPoints: number;
  discountPoints: number;
}

export interface V9WrapperMissingFact {
  factClass: V9WrapperMissingFactClass;
  disposition: Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable">;
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

function roundPoints(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function assertScore(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Safety Score v9 ${field} must be between 0 and 100`);
  }
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

  const adjustments = V9_WRAPPER_LOCAL_FACT_KEYS.map((factKey): V9WrapperLocalRiskAdjustment => {
    const fact = input.localFacts.facts[factKey];
    const maximumDiscountPoints = MAXIMUM_DISCOUNT_POINTS[factKey];
    const assessment = effectiveAssessment(factKey, fact);
    const discountPoints =
      assessment !== null
        ? roundPoints(maximumDiscountPoints * ASSESSMENT_MULTIPLIER[assessment])
        : 0;
    return {
      factKey,
      disposition: fact.disposition,
      assessment,
      maximumDiscountPoints,
      discountPoints,
    };
  });
  const missingFacts: V9WrapperMissingFact[] = adjustments.flatMap((adjustment) =>
    unavailableDisposition(adjustment.disposition)
      ? [{ factClass: adjustment.factKey, disposition: adjustment.disposition }]
      : [],
  );
  if (unavailableDisposition(input.localFacts.formDisposition)) {
    missingFacts.push({ factClass: "wrapperForm", disposition: input.localFacts.formDisposition });
  }
  if (unavailableDisposition(input.localFacts.riskTransfer.disposition)) {
    missingFacts.push({ factClass: "riskTransfer", disposition: input.localFacts.riskTransfer.disposition });
  }
  missingFacts.sort(
    (left, right) =>
      compareText(left.factClass, right.factClass) ||
      compareText(left.disposition, right.disposition),
  );

  const localRiskDiscount = roundPoints(
    adjustments.reduce((sum, adjustment) => sum + adjustment.discountPoints, 0),
  );
  const factsComplete = missingFacts.length === 0;
  const fallbackDiscount = factsComplete ? 0 : configuredFallbackDiscount;
  const appliedDiscount = roundPoints(
    factsComplete ? localRiskDiscount : Math.max(localRiskDiscount, fallbackDiscount),
  );

  const requestedCredit =
    factsComplete &&
    input.localFacts.riskTransfer.disposition === "reviewed" &&
    input.localFacts.riskTransfer.mechanism !== "none"
      ? input.localFacts.riskTransfer.maximumParentLossAbsorptionPoints
      : 0;
  assertScore(requestedCredit, "wrapper risk-transfer credit");
  const scoreBeforeCredit = Math.max(0, input.parentScore - appliedDiscount);
  const appliedCredit = roundPoints(Math.min(requestedCredit, 100 - scoreBeforeCredit));
  const limit = roundPoints(scoreBeforeCredit + appliedCredit);

  return {
    schemaVersion: 1,
    parentScore: input.parentScore,
    form,
    treatment:
      appliedCredit > 0
        ? "documented-risk-transfer"
        : factsComplete
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
