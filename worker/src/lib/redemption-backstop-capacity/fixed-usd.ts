import { resolveCapacityConfidence, resolveCapacitySemantics } from "@shared/lib/redemption-backstop-confidence";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
} from "@shared/lib/redemption-backstop-providers";
import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import { buildBoundedCapacityFields, type CapacityResolution, type CapacityResolverContext } from "./profile";

type FixedUsdModel = Extract<RedemptionCapacityModel, { kind: "fixed-usd" }>;

export function resolveFixedUsdCapacity(
  model: FixedUsdModel,
  context: CapacityResolverContext,
): CapacityResolution {
  const { supplyUsd } = context;
  const capacityConfidence = resolveCapacityConfidence(model);
  const capacitySemantics = resolveCapacitySemantics(model);

  const capacityFields = buildBoundedCapacityFields({
    rawCapacityUsd: model.amountUsd,
    supplyUsd,
    dailyLimitUsd: model.dailyLimitUsd,
    capacityProfileConfidence: capacityConfidence,
    applyDailyLimit: true,
  });
  return {
    immediateCapacityUsd: capacityFields.immediateCapacityUsd,
    immediateCapacityRatio: capacityFields.immediateCapacityRatio,
    scoringCapacityUsd: capacityFields.scoringCapacityUsd,
    scoringCapacityRatio: capacityFields.scoringCapacityRatio,
    capacityProfile: capacityFields.capacityProfile,
    capacityScoreMode: capacityFields.hasPositiveSupply ? "interpolated" : "tier-floor",
    provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL,
    sourceMode:
      REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL].defaultSourceMode,
    resolutionState: "resolved",
    capacityConfidence,
    capacitySemantics,
    notes: [
      ...(capacityFields.capacityExceedsSupply
        ? ["Configured fixed USD capacity exceeds current supply; clamped to supply for scoring"]
        : []),
      ...(supplyUsd == null
        ? [
            "Stablecoins cache missing current supply; fixed USD capacity is visible with conservative bounded scoring",
          ]
        : []),
      ...(capacityFields.dailyLimitCapsCapacity ? ["Documented daily limit caps usable scoring capacity"] : []),
    ],
  };
}
