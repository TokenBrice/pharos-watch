import type { V9SyntheticDeltaNeutralMechanismRiskReview } from "../../../types/safety-score-v9-backing";
import {
  createV9BackingStructuralReason,
  evaluateV9ArchetypeBacking,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
  type V9BackingStructuralReason,
} from "../backing";

export type {
  V9SyntheticDeltaNeutralMechanismRiskReview,
  V9SyntheticVenueShare,
} from "../../../types/safety-score-v9-backing";

export function evaluateV9SyntheticDeltaNeutralBacking(
  asset: V9BackingAssetInput,
  review: V9SyntheticDeltaNeutralMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  const backing = policy.policy.semantic.backing;
  const structuralReasons: V9BackingStructuralReason[] = [];
  if (review.hedgeCoverageRatio < backing.structural.synthetic.minimumHedgeCoverageRatio) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.synthetic.hedgeSignal, {
        pathKey: "mechanism:hedge-reconciliation",
        materialShare: null,
        evidenceRefIds: review.hedgeReconciliation.status.evidenceRefIds,
        failureDomains: review.hedgeReconciliation.failureDomains,
      }),
    );
  }
  if (review.lossAbsorptionShare < backing.structural.synthetic.minimumLossAbsorptionShare) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.synthetic.lossAbsorptionSignal, {
        pathKey: "mechanism:loss-absorption",
        materialShare: review.lossAbsorptionShare,
        evidenceRefIds: review.lossAbsorption.status.evidenceRefIds,
        failureDomains: review.lossAbsorption.failureDomains,
      }),
    );
  }
  for (const venue of [...review.venueShares].sort((left, right) => left.venueKey.localeCompare(right.venueKey))) {
    if (venue.share < backing.structural.commonModeShare) continue;
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.commonModeSignal, {
        pathKey: `venue:${venue.venueKey}`,
        materialShare: venue.share,
        evidenceRefIds: review.venueAndCustody.status.evidenceRefIds,
        failureDomains: venue.failureDomains,
      }),
    );
  }
  return evaluateV9ArchetypeBacking(
    {
      archetype: review.archetype,
      asset,
      components: [
        { componentKey: "venue-and-custody", fact: review.venueAndCustody },
        { componentKey: "hedge-reconciliation", fact: review.hedgeReconciliation },
        { componentKey: "funding-basis-stress", fact: review.fundingBasisStress },
        { componentKey: "margin-and-liquidation", fact: review.marginAndLiquidation },
        { componentKey: "unwind-capacity", fact: review.unwindCapacity },
        { componentKey: "loss-absorption", fact: review.lossAbsorption },
      ],
      additionalStructuralReasons: structuralReasons,
    },
    policy,
  );
}
