import {
  createV9BackingStructuralReason,
  evaluateV9ArchetypeBacking,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
  type V9BackingStructuralReason,
} from "../backing";
import type { V9CdpMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export type { V9CdpMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export function evaluateV9CdpBacking(
  asset: V9BackingAssetInput,
  review: V9CdpMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  const backing = policy.policy.semantic.backing;
  const structuralReasons: V9BackingStructuralReason[] = [];
  if (
    review.metricApplicability.collateralizationRatio.state === "measured" &&
    review.collateralizationRatio !== null &&
    review.collateralizationRatio < backing.structural.cdp.minimumCollateralizationRatio
  ) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.cdp.collateralizationSignal, {
        pathKey: "mechanism:collateralization-parameters",
        materialShare: null,
        evidenceRefIds: review.collateralizationParameters.status.evidenceRefIds,
        failureDomains: review.collateralizationParameters.failureDomains,
      }),
    );
  }
  if (
    review.metricApplicability.liquidationCapacityRatio.state === "measured" &&
    review.liquidationCapacityRatio !== null &&
    review.liquidationCapacityRatio < backing.structural.cdp.minimumLiquidationCapacityRatio
  ) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.cdp.liquidationSignal, {
        pathKey: "mechanism:liquidation-mechanics",
        materialShare: null,
        evidenceRefIds: review.liquidationMechanics.status.evidenceRefIds,
        failureDomains: review.liquidationMechanics.failureDomains,
      }),
    );
  }
  return evaluateV9ArchetypeBacking(
    {
      archetype: review.archetype,
      asset,
      components: [
        { componentKey: "collateralization-parameters", fact: review.collateralizationParameters },
        { componentKey: "liquidation-mechanics", fact: review.liquidationMechanics },
        { componentKey: "backstop", fact: review.backstop },
        { componentKey: "branch-isolation", fact: review.branchIsolation },
        { componentKey: "shutdown-and-bad-debt", fact: review.shutdownAndBadDebt },
        { componentKey: "structural-redemption", fact: review.structuralRedemption },
      ],
      additionalStructuralReasons: structuralReasons,
    },
    policy,
  );
}
