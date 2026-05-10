import type {
  RedemptionCapacityConfidence,
  RedemptionCapacitySemantics,
  RedemptionFeeConfidence,
  RedemptionFeeModelKind,
  RedemptionModelConfidence,
  RedemptionResolutionState,
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
  return REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[
    getProviderIdForCapacityModelKind(model.kind)
  ].defaultCapacityConfidence;
}

export function resolveCapacitySemantics(model: RedemptionCapacityModel): RedemptionCapacitySemantics {
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
}): RedemptionModelConfidence {
  if (args.resolutionState !== "resolved") return "low";
  if (args.capacityConfidence === "heuristic") return "low";
  if (args.capacityConfidence === "live-direct" && args.feeConfidence !== "undisclosed-reviewed") {
    return "high";
  }
  return "medium";
}
