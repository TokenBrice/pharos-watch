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
  if (supplyUsd <= 0) {
    return {
      ...buildMissingSupplyResolution(
        REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
        capacityConfidence,
        capacitySemantics,
      ),
      resolutionState: "missing-capacity",
      notes: ["Current supply is non-positive; route retained as configured but unrated"],
    };
  }
  const immediateUsd = supplyUsd * model.ratio;
  const dailyLimitCapsCapacity = model.dailyLimitUsd != null && model.dailyLimitUsd < immediateUsd;
  const scoringUsd = model.dailyLimitUsd != null ? Math.min(immediateUsd, model.dailyLimitUsd) : immediateUsd;
  return {
    immediateCapacityUsd: immediateUsd,
    immediateCapacityRatio: model.ratio,
    scoringCapacityUsd: scoringUsd,
    scoringCapacityRatio:
      model.dailyLimitUsd != null && supplyUsd > 0
        ? Math.min(model.ratio, model.dailyLimitUsd / supplyUsd)
        : model.ratio,
    capacityProfile: {
      immediateUsd,
      ...(model.dailyLimitUsd != null ? { dailyLimitUsd: model.dailyLimitUsd } : {}),
      scoringUsd,
      scoringHorizon: dailyLimitCapsCapacity ? "daily" : "immediate",
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
