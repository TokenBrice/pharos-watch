import {
  createV9BackingStructuralReason,
  evaluateV9ArchetypeBacking,
  v9StructuralResponsibilityForStatus,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
  type V9BackingStructuralReason,
} from "../backing";
import type { V9RwaCreditFundMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export type { V9RwaCreditFundMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export function evaluateV9RwaCreditFundBacking(
  asset: V9BackingAssetInput,
  review: V9RwaCreditFundMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  const backing = policy.policy.semantic.backing;
  const structuralReasons: V9BackingStructuralReason[] = [];
  // Owner ruling 2026-07-27 (wave-7 D2): an `unavailable` maturity metric
  // keeps the mismatch signal firing — an unmeasured book is never presumed
  // short-dated — while an evidenced `not-applicable` metric skips it. Absent
  // applicability means the metric is measured (legacy full-metric reviews).
  const maturityState = review.metricApplicability?.weightedAverageMaturityDays.state ?? "measured";
  if (
    maturityState === "unavailable" ||
    (maturityState === "measured" &&
      review.weightedAverageMaturityDays !== null &&
      review.weightedAverageMaturityDays > backing.structural.rwaCreditFund.maturityMismatchDays)
  ) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.rwaCreditFund.signal, {
        responsibility: v9StructuralResponsibilityForStatus(review.maturityAndLiquidity.status),
        pathKey: "mechanism:maturity-and-liquidity",
        materialShare: null,
        evidenceRefIds: review.maturityAndLiquidity.status.evidenceRefIds,
        failureDomains: review.maturityAndLiquidity.failureDomains,
      }),
    );
  }
  return evaluateV9ArchetypeBacking(
    {
      archetype: review.archetype,
      asset,
      components: [
        { componentKey: "credit-quality", fact: review.creditQuality },
        { componentKey: "seniority", fact: review.seniority },
        { componentKey: "legal-enforceability", fact: review.legalEnforceability },
        { componentKey: "valuation-cadence", fact: review.valuationCadence },
        { componentKey: "maturity-and-liquidity", fact: review.maturityAndLiquidity },
        { componentKey: "custody", fact: review.custody },
        { componentKey: "recovery", fact: review.recovery },
      ],
      additionalStructuralReasons: structuralReasons,
    },
    policy,
  );
}
