import {
  createV9BackingStructuralReason,
  evaluateV9ArchetypeBacking,
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
  if (review.weightedAverageMaturityDays > backing.structural.rwaCreditFund.maturityMismatchDays) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.rwaCreditFund.signal, {
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
