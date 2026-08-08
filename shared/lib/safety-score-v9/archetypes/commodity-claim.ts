import {
  evaluateV9ArchetypeBacking,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
} from "../backing";
import type { V9CommodityClaimMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export type { V9CommodityClaimMechanismRiskReview } from "../../../types/safety-score-v9-backing";

/**
 * Direct commodity claims. `physical-redemption` is a weighted mechanism
 * component here; the Exit pillar reads a projection of the same curated fact
 * rather than a second declaration, so the two pillars cannot disagree and the
 * fact is only ever authored once.
 */
export function evaluateV9CommodityClaimBacking(
  asset: V9BackingAssetInput,
  review: V9CommodityClaimMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  return evaluateV9ArchetypeBacking(
    {
      archetype: review.archetype,
      asset,
      components: [
        { componentKey: "title-and-allocation", fact: review.titleAndAllocation },
        { componentKey: "custody-continuity", fact: review.custodyContinuity },
        { componentKey: "assurance-and-reconciliation", fact: review.assuranceAndReconciliation },
        { componentKey: "physical-redemption", fact: review.physicalRedemption },
      ],
    },
    policy,
  );
}
