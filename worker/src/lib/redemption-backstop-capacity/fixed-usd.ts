import { resolveCapacityConfidence, resolveCapacitySemantics } from "@shared/lib/redemption-backstop-confidence";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
} from "@shared/lib/redemption-backstop-providers";
import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import type { CapacityResolution, CapacityResolverContext } from "./profile";

type FixedUsdModel = Extract<RedemptionCapacityModel, { kind: "fixed-usd" }>;

export async function resolveFixedUsdCapacity(
  model: FixedUsdModel,
  context: CapacityResolverContext,
): Promise<CapacityResolution> {
  const { supplyUsd } = context;
  const capacityConfidence = resolveCapacityConfidence(model);
  const capacitySemantics = resolveCapacitySemantics(model);

  const hasPositiveSupply = supplyUsd != null && supplyUsd > 0;
  const rawCapacityUsd = Math.max(0, model.amountUsd);
  const immediateCapacityUsd = supplyUsd != null ? Math.min(supplyUsd, rawCapacityUsd) : rawCapacityUsd;
  const immediateCapacityRatio = hasPositiveSupply ? Math.min(1, immediateCapacityUsd / supplyUsd) : null;
  const dailyLimitUsd = model.dailyLimitUsd;
  const dailyLimitCapsCapacity = dailyLimitUsd != null && dailyLimitUsd < immediateCapacityUsd;
  // Equivalent to capping at the daily limit only when it is below immediate capacity; avoids a cast.
  const scoringCapacityUsd =
    dailyLimitUsd != null ? Math.max(0, Math.min(dailyLimitUsd, immediateCapacityUsd)) : immediateCapacityUsd;
  const scoringCapacityRatio = hasPositiveSupply ? Math.min(1, scoringCapacityUsd / supplyUsd) : null;
  return {
    immediateCapacityUsd,
    immediateCapacityRatio,
    scoringCapacityUsd,
    scoringCapacityRatio,
    capacityScoreMode: hasPositiveSupply ? "interpolated" : "tier-floor",
    capacityProfile: {
      immediateUsd: immediateCapacityUsd,
      ...(dailyLimitUsd != null ? { dailyLimitUsd } : {}),
      scoringUsd: scoringCapacityUsd,
      scoringHorizon: dailyLimitCapsCapacity ? "daily" : "immediate",
      capacityProfileConfidence: capacityConfidence,
    },
    provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL,
    sourceMode:
      REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL].defaultSourceMode,
    resolutionState: "resolved",
    capacityConfidence,
    capacitySemantics,
    notes: [
      ...(supplyUsd != null && rawCapacityUsd > supplyUsd
        ? ["Configured fixed USD capacity exceeds current supply; clamped to supply for scoring"]
        : []),
      ...(supplyUsd == null
        ? [
            "Stablecoins cache missing current supply; fixed USD capacity is visible with conservative bounded scoring",
          ]
        : []),
      ...(dailyLimitCapsCapacity ? ["Documented daily limit caps usable scoring capacity"] : []),
    ],
  };
}
