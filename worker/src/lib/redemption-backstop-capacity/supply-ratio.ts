import { resolveCapacityConfidence, resolveCapacitySemantics } from "@shared/lib/redemption-backstop-confidence";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
} from "@shared/lib/redemption-backstop-providers";
import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import { buildBoundedCapacityFields, buildMissingSupplyResolution, type CapacityResolution, type CapacityResolverContext } from "./profile";

type SupplyRatioModel = Extract<RedemptionCapacityModel, { kind: "supply-ratio" }>;

export function resolveSupplyRatioCapacity(
  model: SupplyRatioModel,
  context: CapacityResolverContext,
): CapacityResolution {
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
  const capacityFields = buildBoundedCapacityFields({
    rawCapacityUsd: supplyUsd * model.ratio,
    supplyUsd,
    dailyLimitUsd: model.dailyLimitUsd,
    capacityProfileConfidence: capacityConfidence,
    applyDailyLimit: true,
  });
  return {
    immediateCapacityUsd: capacityFields.immediateCapacityUsd,
    // Preserve the authored ratio instead of introducing a USD round-trip.
    immediateCapacityRatio: model.ratio,
    scoringCapacityUsd: capacityFields.scoringCapacityUsd,
    scoringCapacityRatio: capacityFields.dailyLimitCapsCapacity ? capacityFields.scoringCapacityRatio : model.ratio,
    capacityProfile: capacityFields.capacityProfile,
    provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
    sourceMode:
      REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL].defaultSourceMode,
    resolutionState: "resolved",
    capacityConfidence,
    capacitySemantics,
    notes: [],
  };
}
