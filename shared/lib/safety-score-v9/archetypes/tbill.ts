import {
  evaluateV9ArchetypeBacking,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
} from "../backing";
import type { V9TbillMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export type { V9TbillMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export function evaluateV9TbillBacking(
  asset: V9BackingAssetInput,
  review: V9TbillMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  return evaluateV9ArchetypeBacking(
    {
      archetype: review.archetype,
      asset,
      components: [
        { componentKey: "fund-claim-and-seniority", fact: review.fundClaimAndSeniority },
        { componentKey: "nav-valuation", fact: review.navValuation },
        { componentKey: "duration-and-liquidity", fact: review.durationAndLiquidity },
        { componentKey: "loss-recovery-design", fact: review.lossRecoveryDesign },
      ],
    },
    policy,
  );
}
