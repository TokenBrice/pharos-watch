import { resolveCapacityConfidence, resolveCapacitySemantics } from "@shared/lib/redemption-backstop-confidence";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
} from "@shared/lib/redemption-backstop-providers";
import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import { buildMissingSupplyResolution, type CapacityResolution, type CapacityResolverContext } from "./profile";

type SupplyFullModel = Extract<RedemptionCapacityModel, { kind: "supply-full" }>;

export async function resolveSupplyFullCapacity(
  model: SupplyFullModel,
  context: CapacityResolverContext,
): Promise<CapacityResolution> {
  const { supplyUsd } = context;
  const capacityConfidence = resolveCapacityConfidence(model);
  const capacitySemantics = resolveCapacitySemantics(model);

  if (supplyUsd == null) {
    return buildMissingSupplyResolution(
      REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL,
      capacityConfidence,
      capacitySemantics,
    );
  }
  return {
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    scoringCapacityUsd: null,
    scoringCapacityRatio: null,
    eventualCapacityUsd: supplyUsd,
    eventualCapacityRatio: supplyUsd > 0 ? 1 : null,
    capacityProfile: {
      immediateUsd: null,
      eventualUsd: supplyUsd,
      scoringUsd: null,
      scoringHorizon: "eventual",
      capacityProfileConfidence: capacityConfidence,
    },
    provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL,
    sourceMode:
      REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL].defaultSourceMode,
    resolutionState: "resolved",
    capacityConfidence,
    capacitySemantics,
    notes: ["Modeled as eventual redeemability of current supply; immediate liquidity is not separately quantified"],
  };
}
