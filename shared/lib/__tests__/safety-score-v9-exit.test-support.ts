import type { V9ExitEvaluationRoute } from "@shared/lib/safety-score-v9/exit";
import type { V9ExitRouteFactV2 } from "@shared/types/safety-score-v9-facts";

export function makeExitRoute(overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute {
  return {
    routeKey: "redemption:issuer",
    lane: "redemption",
    routeFamily: "issuer-redemption",
    applicability: "required",
    settlementBoundUnproven: false,
    observationState: "known",
    scoreEligible: true,
    coverageClass: "exact-complete",
    evidenceKind: "onchain-contract-state",
    observationConfidence: "high",
    modelConfidence: "high",
    access: "permissionless-onchain",
    holderEligibility: "any-holder",
    capacityScoringHorizon: "immediate",
    settlement: "atomic",
    settlementDelaySec: 300,
    queueDepthUsd: null,
    dailyLimitUsd: null,
    minRedeemUsd: null,
    execution: "deterministic-onchain",
    outputQuality: "stable-single",
    outputResolved: true,
    outputValueRetention: 1,
    capacityCurve: [100_000, 1_000_000, 10_000_000, 25_000_000].map((requestedNotionalUsd) => ({
      requestedNotionalUsd, maxCostBps: 200, executableUsd: requestedNotionalUsd,
      completionRatio: 1, executionCostBps: 0,
    })),
    routeScoreCap: null,
    failureDomains: ["redemption-rail:issuer"],
    physicalResourceKeys: ["rail:issuer"],
    ...overrides,
  };
}

export function makeDocumentedRedemption(overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute {
  return makeExitRoute({
    routeKey: "redemption:issuer-documented",
    routeFamily: "issuer-redemption",
    scoreEligible: false,
    coverageClass: "exact-lower-bound",
    evidenceKind: "documented-terms",
    access: "issuer-api",
    execution: "rules-based-nav",
    settlement: "same-day",
    settlementDelaySec: 86_400,
    capacityCurve: [1_000_000, 10_000_000].map((requestedNotionalUsd) => ({
      requestedNotionalUsd, maxCostBps: 200, executableUsd: requestedNotionalUsd,
      completionRatio: 1, executionCostBps: 10,
    })),
    ...overrides,
  });
}

export function makeNormalizedExitRoute(overrides: Partial<V9ExitRouteFactV2> = {}): V9ExitRouteFactV2 {
  return {
    routeKey: "redemption:generation:route",
    routeId: "route",
    lane: "redemption",
    sourceGenerationId: "generation",
    routeFamily: "issuer-redemption",
    holderAccess: "allowlisted",
    executionModel: "deterministic",
    executionCertainty: "bounded",
    modelConfidence: "high",
    observationConfidence: "medium",
    evidenceKind: "documented-terms",
    coverageClass: "exact-lower-bound",
    settlementModel: "same-day",
    settlementSlaSec: 86_400,
    settlementEvidenceRefIds: ["settlement"],
    physicalResourceKeys: ["rail:issuer"],
    status: {
      applicability: { state: "required", policyRuleId: "route-required", rationale: null, gapId: null },
      observationState: "known", evidenceRefIds: ["route"], gapIds: [],
    },
    scoreEligible: true,
    request: { requestedNotionalUsd: 1_000_000, maxCostBps: 200, settlementHorizonSec: 300 },
    capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1, executionCostBps: 10 }],
    output: {
      status: {
        applicability: { state: "required", policyRuleId: "output-required", rationale: null, gapId: null },
        observationState: "known", evidenceRefIds: ["valuation"], gapIds: [],
      },
      kind: "fiat", assetKeys: ["USD"], basketWeights: [],
      valuation: {
        basis: "reviewed-par", referenceAssetKey: "USD", unitValueUsd: 1,
        expectedUnitValueUsd: 1, valueRetentionRatio: 1,
        sourceId: "valuation-source", sourceGenerationId: "valuation-generation",
        observedAtSec: 1, asOfSec: 1, confidence: "high",
        freshness: { state: "current", ageSec: 0, maxAgeSec: 1 }, evidenceRefIds: ["valuation"],
      },
    },
    failureDomains: [{ kind: "redemption-rail", key: "issuer" }],
    ...overrides,
  };
}
