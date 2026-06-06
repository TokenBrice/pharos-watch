import { resolveCapacityConfidence, resolveCapacitySemantics } from "@shared/lib/redemption-backstop-confidence";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
} from "@shared/lib/redemption-backstop-providers";
import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import { buildMissingSupplyResolution, type CapacityResolution, type CapacityResolverContext } from "./profile";

type SupplyRatioModel = Extract<RedemptionCapacityModel, { kind: "supply-ratio" }>;

export async function resolveSupplyRatioCapacity(
  model: SupplyRatioModel,
  context: CapacityResolverContext,
): Promise<CapacityResolution> {
  const { supplyUsd } = context;
  const capacityConfidence = resolveCapacityConfidence(model);
  const capacitySemantics = resolveCapacitySemantics(model);

  if (supplyUsd == null) {
    return buildMissingSupplyResolution(
      REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
      capacityConfidence,
      capacitySemantics,
    );
  }
  return {
    immediateCapacityUsd: supplyUsd * model.ratio,
    immediateCapacityRatio: model.ratio,
    scoringCapacityUsd:
      model.dailyLimitUsd != null ? Math.min(supplyUsd * model.ratio, model.dailyLimitUsd) : supplyUsd * model.ratio,
    scoringCapacityRatio:
      model.dailyLimitUsd != null && supplyUsd > 0
        ? Math.min(model.ratio, model.dailyLimitUsd / supplyUsd)
        : model.ratio,
    capacityProfile: {
      immediateUsd: supplyUsd * model.ratio,
      ...(model.dailyLimitUsd != null ? { dailyLimitUsd: model.dailyLimitUsd } : {}),
      scoringUsd:
        model.dailyLimitUsd != null
          ? Math.min(supplyUsd * model.ratio, model.dailyLimitUsd)
          : supplyUsd * model.ratio,
      scoringHorizon: model.dailyLimitUsd != null ? "daily" : "immediate",
      capacityProfileConfidence: capacityConfidence,
    },
    provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
    sourceMode:
      REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL].defaultSourceMode,
    resolutionState: "resolved",
    capacityConfidence,
    capacitySemantics,
    notes: [],
  };
}
