import type {
  RedemptionCapacityConfidence,
  RedemptionFeeConfidence,
  RedemptionModelConfidence,
  RedemptionResolutionState,
  RedemptionSourceMode,
} from "../types";
import type { RedemptionCapacityModel, RedemptionCostModel } from "./redemption-backstops";

export function resolveCapacityConfidence(model: RedemptionCapacityModel): RedemptionCapacityConfidence {
  if (model.confidence) return model.confidence;
  if (model.kind === "reserve-sync-metadata") return "dynamic";
  if (model.kind === "supply-ratio") return "documented-bound";
  return "heuristic";
}

export function resolveFeeConfidence(model: RedemptionCostModel): RedemptionFeeConfidence {
  if (model.kind === "fee-bps") {
    return model.confidence ?? "fixed";
  }
  return model.confidence ?? "undisclosed-reviewed";
}

export function inferStoredCapacityConfidence(args: {
  provider: string;
  sourceMode: RedemptionSourceMode;
}): RedemptionCapacityConfidence {
  if (args.sourceMode === "dynamic") return "dynamic";
  if (
    args.provider === "reserve-sync-metadata" ||
    args.provider === "reserve-sync-fallback" ||
    args.provider === "supply-ratio-model"
  ) {
    return "documented-bound";
  }
  return "heuristic";
}

export function inferStoredFeeConfidence(args: {
  feeBps: number | null;
}): RedemptionFeeConfidence {
  if (args.feeBps != null) return "fixed";
  return "undisclosed-reviewed";
}

export function deriveModelConfidence(args: {
  resolutionState: RedemptionResolutionState;
  capacityConfidence: RedemptionCapacityConfidence;
  feeConfidence: RedemptionFeeConfidence;
}): RedemptionModelConfidence {
  if (args.resolutionState !== "resolved") return "low";
  if (args.capacityConfidence === "heuristic") return "low";
  if (args.capacityConfidence === "dynamic" && args.feeConfidence !== "undisclosed-reviewed") {
    return "high";
  }
  return "medium";
}
