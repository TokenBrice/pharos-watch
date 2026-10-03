import { evaluateV9ArchetypeBacking } from "./evaluation";
import {
  createV9BackingStructuralReason,
  v9StructuralResponsibilityForStatus,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
  type V9BackingStructuralReason,
} from "../backing-primitives";
import type {
  V9MechanismMetricApplicability,
  V9RwaCreditFundMechanismRiskReview,
} from "../../../types/safety-score-v9-backing";

export type { V9RwaCreditFundMechanismRiskReview } from "../../../types/safety-score-v9-backing";

export function resolveV9MetricApplicability(
  applicability: V9MechanismMetricApplicability | undefined,
  status: Parameters<typeof v9StructuralResponsibilityForStatus>[0],
) {
  const state = applicability?.state ?? "measured";
  const unavailable = applicability?.state === "unavailable";
  return {
    state,
    unavailable,
    responsibility: v9StructuralResponsibilityForStatus(status),
    evidenceRefIds: unavailable ? applicability.evidenceRefIds : status.evidenceRefIds,
  };
}

export function evaluateV9RwaCreditFundBacking(
  asset: V9BackingAssetInput,
  review: V9RwaCreditFundMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  const backing = policy.policy.semantic.backing;
  const structuralReasons: V9BackingStructuralReason[] = [];
  // Only a measured metric supports a structural mismatch; absence is bounded.
  const maturityApplicability = resolveV9MetricApplicability(
    review.metricApplicability?.weightedAverageMaturityDays,
    review.maturityAndLiquidity.status,
  );
  if (
    maturityApplicability.state === "measured" &&
    review.maturityAndLiquidity.status.observationState === "known" &&
    review.maturityAndLiquidity.status.evidenceRefIds.length > 0 &&
    review.weightedAverageMaturityDays !== null &&
    review.weightedAverageMaturityDays > backing.structural.rwaCreditFund.maturityMismatchDays
  ) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.rwaCreditFund.signal, {
        responsibility: maturityApplicability.responsibility,
        pathKey: "mechanism:maturity-and-liquidity",
        metricApplicability: maturityApplicability.state,
        materialShare: null,
        evidenceRefIds: maturityApplicability.evidenceRefIds,
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
