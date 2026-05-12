import type {
  RedemptionCapacityConfidence,
  RedemptionCapacitySemantics,
  RedemptionConfidenceDetails,
  RedemptionFeeConfidence,
  RedemptionFeeModelKind,
  RedemptionHolderEligibility,
  RedemptionLiveFreshnessKind,
  RedemptionModelConfidence,
  RedemptionResolutionState,
  RedemptionRouteStatus,
  RedemptionRouteStatusSource,
  RedemptionSourceMode,
} from "../types";
import type { RedemptionCapacityModel, RedemptionCostModel } from "./redemption-backstops";
import {
  getProviderIdForCapacityModelKind,
  inferProviderCapacityConfidence,
  inferProviderCapacitySemantics,
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
} from "./redemption-backstop-providers";

export function resolveCapacityConfidence(model: RedemptionCapacityModel): RedemptionCapacityConfidence {
  if (model.confidence) return model.confidence;
  if (model.kind === "fixed-usd") return "documented-bound";
  return REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[
    getProviderIdForCapacityModelKind(model.kind)
  ].defaultCapacityConfidence;
}

export function resolveCapacitySemantics(model: RedemptionCapacityModel): RedemptionCapacitySemantics {
  if (model.kind === "fixed-usd") return "immediate-bounded";
  return REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[
    getProviderIdForCapacityModelKind(model.kind)
  ].defaultCapacitySemantics;
}

export function resolveFeeConfidence(model: RedemptionCostModel): RedemptionFeeConfidence {
  if (model.kind === "fee-bps") {
    return model.confidence ?? "fixed";
  }
  return model.confidence ?? "undisclosed-reviewed";
}

export function resolveFeeModelKind(model: RedemptionCostModel): RedemptionFeeModelKind {
  if (model.kind === "fee-bps") {
    return "fixed-bps";
  }

  if (model.feeModelKind) return model.feeModelKind;
  if (model.confidence === "formula") return "formula";
  if (model.feeDescription) return "documented-variable";
  return "undisclosed-reviewed";
}

export function inferStoredCapacityConfidence(args: {
  provider: string;
  sourceMode: RedemptionSourceMode;
}): RedemptionCapacityConfidence {
  return inferProviderCapacityConfidence(args);
}

export function inferStoredCapacitySemantics(args: {
  provider: string;
}): RedemptionCapacitySemantics {
  return inferProviderCapacitySemantics(args);
}

export function inferStoredFeeConfidence(args: {
  feeBps: number | null;
}): RedemptionFeeConfidence {
  if (args.feeBps != null) return "fixed";
  return "undisclosed-reviewed";
}

export function inferStoredFeeModelKind(args: {
  feeBps: number | null;
  feeConfidence: RedemptionFeeConfidence;
  feeDescription?: string;
}): RedemptionFeeModelKind {
  if (args.feeBps != null) return "fixed-bps";
  if (args.feeConfidence === "formula") return "formula";
  if (args.feeDescription) return "documented-variable";
  return "undisclosed-reviewed";
}

export function deriveModelConfidence(args: {
  resolutionState: RedemptionResolutionState;
  capacityConfidence: RedemptionCapacityConfidence;
  feeConfidence: RedemptionFeeConfidence;
  routeStatus?: RedemptionRouteStatus;
  routeStatusSource?: RedemptionRouteStatusSource;
  reviewedAt?: string;
  holderEligibility?: RedemptionHolderEligibility;
  sourceMode?: RedemptionSourceMode;
  freshnessKind?: RedemptionLiveFreshnessKind;
  now?: number;
}): RedemptionModelConfidence {
  if (args.resolutionState !== "resolved") return "low";
  return deriveModelConfidenceWithDetails(args).modelConfidence;
}

export function deriveModelConfidenceWithDetails(args: {
  resolutionState: RedemptionResolutionState;
  capacityConfidence: RedemptionCapacityConfidence;
  feeConfidence: RedemptionFeeConfidence;
  routeStatus?: RedemptionRouteStatus;
  routeStatusSource?: RedemptionRouteStatusSource;
  reviewedAt?: string;
  holderEligibility?: RedemptionHolderEligibility;
  sourceMode?: RedemptionSourceMode;
  freshnessKind?: RedemptionLiveFreshnessKind;
  now?: number;
}): {
  modelConfidence: RedemptionModelConfidence;
  confidenceDetails: RedemptionConfidenceDetails;
} {
  const reviewedDocAgeDays = computeReviewedDocAgeDays(args.reviewedAt, args.now);
  const details: RedemptionConfidenceDetails = {
    capacityEvidenceQuality: scoreCapacityEvidence(args.capacityConfidence),
    feeEvidenceQuality: scoreFeeEvidence(args.feeConfidence),
    routeStatusFreshness: scoreRouteStatusFreshness(args.routeStatus, args.routeStatusSource),
    holderCohortBreadth: scoreHolderCohortBreadth(args.holderEligibility),
    sourceQuality: scoreSourceQuality(args.sourceMode, args.freshnessKind),
    reviewedDocAgeDays,
    reasons: [],
  };

  if (args.resolutionState !== "resolved") {
    details.reasons?.push("Route is not currently resolved");
    return { modelConfidence: "low", confidenceDetails: details };
  }

  if (args.capacityConfidence === "heuristic") {
    details.reasons?.push("Capacity evidence is heuristic");
    return { modelConfidence: "low", confidenceDetails: details };
  }

  if (args.routeStatus === "unknown" && args.capacityConfidence !== "live-direct") {
    details.reasons?.push("Route status is unknown without direct live telemetry");
    return { modelConfidence: "low", confidenceDetails: details };
  }

  if (
    args.holderEligibility === "issuer-discretionary" ||
    args.holderEligibility === "unknown"
  ) {
    details.reasons?.push("Holder eligibility is narrow or unclear");
    return { modelConfidence: "low", confidenceDetails: details };
  }

  if (
    reviewedDocAgeDays != null &&
    reviewedDocAgeDays > 365 &&
    !hasCurrentRouteStatusEvidence(args.routeStatusSource)
  ) {
    details.reasons?.push("Reviewed documentation is older than one year without current route-status evidence");
    return { modelConfidence: "low", confidenceDetails: details };
  }

  if (args.capacityConfidence === "live-direct" && args.feeConfidence !== "undisclosed-reviewed") {
    return { modelConfidence: "high", confidenceDetails: details };
  }

  return { modelConfidence: "medium", confidenceDetails: details };
}

function scoreCapacityEvidence(confidence: RedemptionCapacityConfidence): number {
  switch (confidence) {
    case "live-direct":
      return 100;
    case "live-proxy":
      return 80;
    case "dynamic":
      return 65;
    case "documented-bound":
      return 60;
    case "heuristic":
      return 25;
  }
}

function scoreFeeEvidence(confidence: RedemptionFeeConfidence): number {
  switch (confidence) {
    case "fixed":
      return 100;
    case "formula":
      return 80;
    case "undisclosed-reviewed":
      return 45;
  }
}

function scoreRouteStatusFreshness(
  routeStatus: RedemptionRouteStatus | undefined,
  routeStatusSource: RedemptionRouteStatusSource | undefined,
): number {
  if (routeStatus === "open" && hasCurrentRouteStatusEvidence(routeStatusSource)) return 100;
  if (routeStatus === "open") return 70;
  if (routeStatus === "unknown") return 30;
  if (routeStatus) return 20;
  return 50;
}

function scoreHolderCohortBreadth(holderEligibility: RedemptionHolderEligibility | undefined): number {
  switch (holderEligibility) {
    case "any-holder":
      return 100;
    case "verified-customer":
      return 75;
    case "whitelisted-primary":
    case "pre-incident-holder":
      return 55;
    case "issuer-discretionary":
      return 25;
    case "unknown":
      return 30;
    default:
      return 60;
  }
}

function scoreSourceQuality(
  sourceMode: RedemptionSourceMode | undefined,
  freshnessKind: RedemptionLiveFreshnessKind | undefined,
): number {
  if (freshnessKind === "verified-source-timestamp" || freshnessKind === "same-run-onchain") return 100;
  if (freshnessKind === "same-run-api") return 90;
  if (sourceMode === "dynamic") return 75;
  if (sourceMode === "estimated") return 50;
  if (sourceMode === "static") return 40;
  return 50;
}

function hasCurrentRouteStatusEvidence(source: RedemptionRouteStatusSource | undefined): boolean {
  return source === "operator-notice" || source === "protocol-api" || source === "onchain" || source === "market-implied";
}

function computeReviewedDocAgeDays(reviewedAt: string | undefined, now = Math.floor(Date.now() / 1000)): number | null {
  if (!reviewedAt) return null;
  const reviewedMs = Date.parse(`${reviewedAt}T00:00:00Z`);
  if (!Number.isFinite(reviewedMs)) return null;
  return Math.max(0, Math.floor((now * 1000 - reviewedMs) / 86_400_000));
}
