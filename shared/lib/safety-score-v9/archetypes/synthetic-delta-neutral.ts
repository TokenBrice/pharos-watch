import type { V9SyntheticDeltaNeutralMechanismRiskReview } from "../../../types/safety-score-v9-backing";
import { compareText } from "../../../types/safety-score-v9-fact-primitives";
import {
  createV9BackingStructuralReason,
  evaluateV9ArchetypeBacking,
  v9StructuralResponsibilityForStatus,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
  type V9BackingStructuralReason,
} from "../backing";
import { resolveV9MetricApplicability } from "./rwa-credit-fund";

export type { V9SyntheticDeltaNeutralMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export function evaluateV9SyntheticDeltaNeutralBacking(
  asset: V9BackingAssetInput,
  review: V9SyntheticDeltaNeutralMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  const backing = policy.policy.semantic.backing;
  const structuralReasons: V9BackingStructuralReason[] = [];
  // Owner ruling 2026-07-27 (wave-7 D2): an `unavailable` metric keeps its
  // structural signal firing — unmeasured is never presumed adequate — while
  // an evidenced `not-applicable` metric skips it. Absent applicability means
  // the metric is measured (legacy full-metric reviews).
  const hedgeApplicability = resolveV9MetricApplicability(
    review.metricApplicability?.hedgeCoverageRatio,
    review.hedgeReconciliation.status,
  );
  const lossAbsorptionApplicability = resolveV9MetricApplicability(
    review.metricApplicability?.lossAbsorptionShare,
    review.lossAbsorption.status,
  );
  if (
    hedgeApplicability.unavailable ||
    (hedgeApplicability.state === "measured" &&
      review.hedgeCoverageRatio !== null &&
      review.hedgeCoverageRatio < backing.structural.synthetic.minimumHedgeCoverageRatio)
  ) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.synthetic.hedgeSignal, {
        responsibility: hedgeApplicability.responsibility,
        pathKey: "mechanism:hedge-reconciliation",
        materialShare: null,
        evidenceRefIds: hedgeApplicability.evidenceRefIds,
        failureDomains: review.hedgeReconciliation.failureDomains,
      }),
    );
  }
  if (
    lossAbsorptionApplicability.unavailable ||
    (lossAbsorptionApplicability.state === "measured" &&
      review.lossAbsorptionShare !== null &&
      review.lossAbsorptionShare < backing.structural.synthetic.minimumLossAbsorptionShare)
  ) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.synthetic.lossAbsorptionSignal, {
        responsibility: lossAbsorptionApplicability.responsibility,
        pathKey: "mechanism:loss-absorption",
        materialShare: review.lossAbsorptionShare,
        evidenceRefIds: lossAbsorptionApplicability.evidenceRefIds,
        failureDomains: review.lossAbsorption.failureDomains,
      }),
    );
  }
  for (const venue of [...review.venueShares].sort((left, right) => compareText(left.venueKey, right.venueKey))) {
    if (venue.share < backing.structural.commonModeShare) continue;
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.commonModeSignal, {
        responsibility: v9StructuralResponsibilityForStatus(review.venueAndCustody.status),
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
