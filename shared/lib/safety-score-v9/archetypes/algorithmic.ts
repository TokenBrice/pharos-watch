import {
  createV9BackingStructuralReason,
  evaluateV9ArchetypeBacking,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
  type V9BackingStructuralReason,
} from "../backing";
import type { V9AlgorithmicMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export type { V9AlgorithmicMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export function evaluateV9AlgorithmicBacking(
  asset: V9BackingAssetInput,
  review: V9AlgorithmicMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  const backing = policy.policy.semantic.backing;
  const structuralReasons: V9BackingStructuralReason[] = [];
  if (review.reflexiveBackingShare >= backing.structural.algorithmic.materialReflexiveShare) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.algorithmic.signal, {
        pathKey: "mechanism:confidence-and-incentives",
        materialShare: review.reflexiveBackingShare,
        evidenceRefIds: review.confidenceAndIncentives.status.evidenceRefIds,
        failureDomains: review.confidenceAndIncentives.failureDomains,
      }),
    );
  }
  return evaluateV9ArchetypeBacking(
    {
      archetype: review.archetype,
      asset,
      components: [
        { componentKey: "contraction-capacity", fact: review.contractionCapacity },
        { componentKey: "confidence-and-incentives", fact: review.confidenceAndIncentives },
        { componentKey: "oracle-and-control-assumptions", fact: review.oracleAndControlAssumptions },
        { componentKey: "emergency-recovery", fact: review.emergencyRecovery },
        { componentKey: "loss-recovery", fact: review.lossRecovery },
      ],
      additionalStructuralReasons: structuralReasons,
    },
    policy,
  );
}
