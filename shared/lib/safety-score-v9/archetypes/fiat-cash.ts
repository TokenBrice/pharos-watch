import {
  evaluateV9ArchetypeBacking,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
} from "../backing";
import type { V9FiatCashMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export type { V9FiatCashMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export function evaluateV9FiatCashBacking(
  asset: V9BackingAssetInput,
  review: V9FiatCashMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  return evaluateV9ArchetypeBacking(
    {
      archetype: review.archetype,
      asset,
      components: [
        { componentKey: "claim-and-segregation", fact: review.claimAndSegregation },
        { componentKey: "custody-continuity", fact: review.custodyContinuity },
        { componentKey: "assurance-and-reconciliation", fact: review.assuranceAndReconciliation },
      ],
    },
    policy,
  );
}
