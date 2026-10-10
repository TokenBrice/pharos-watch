import { resolveCapacityConfidence, resolveCapacitySemantics } from "@shared/lib/redemption-backstop-confidence";
import { REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS, REDEMPTION_BACKSTOP_PROVIDER_IDS } from "@shared/lib/redemption-backstop-providers";
import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import { buildBoundedCapacityFields, buildMissingSupplyResolution, type CapacityResolution, type CapacityResolverContext } from "./profile";

type StaticCapacityModel = Extract<RedemptionCapacityModel, { kind: "fixed-usd" | "supply-full" | "supply-ratio" }>;
const STATIC_PROVIDERS = {
  "fixed-usd": REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL,
  "supply-full": REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL,
  "supply-ratio": REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
} as const;

export function resolveStaticCapacity(model: StaticCapacityModel, context: CapacityResolverContext): CapacityResolution {
  const { supplyUsd } = context;
  const capacityConfidence = resolveCapacityConfidence(model);
  const capacitySemantics = resolveCapacitySemantics(model);
  const providerId = STATIC_PROVIDERS[model.kind];
  const provider = REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[providerId];
  if (model.kind !== "fixed-usd" && supplyUsd == null) {
    return buildMissingSupplyResolution(providerId, capacityConfidence, capacitySemantics);
  }
  if (model.kind === "supply-full") {
    return {
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      scoringCapacityUsd: null,
      scoringCapacityRatio: null,
      eventualCapacityUsd: supplyUsd,
      eventualCapacityRatio: supplyUsd! > 0 ? 1 : null,
      capacityProfile: {
        immediateUsd: null,
        eventualUsd: supplyUsd,
        scoringUsd: null,
        scoringHorizon: "eventual",
        capacityProfileConfidence: capacityConfidence,
      },
      provider: providerId,
      sourceMode: provider.defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence,
      capacitySemantics,
      notes: ["Modeled as eventual redeemability of current supply; immediate liquidity is not separately quantified"],
    };
  }
  if (model.kind === "supply-ratio" && supplyUsd! <= 0) {
    return {
      ...buildMissingSupplyResolution(providerId, capacityConfidence, capacitySemantics),
      resolutionState: "missing-capacity",
      notes: ["Current supply is non-positive; route retained as configured but unrated"],
    };
  }
  const capacityFields = buildBoundedCapacityFields({
    rawCapacityUsd: model.kind === "fixed-usd" ? model.amountUsd : supplyUsd! * model.ratio,
    supplyUsd,
    dailyLimitUsd: model.dailyLimitUsd,
    capacityProfileConfidence: capacityConfidence,
    applyDailyLimit: true,
  });
  return {
    immediateCapacityUsd: capacityFields.immediateCapacityUsd,
    // Preserve the authored ratio instead of introducing a USD round-trip.
    immediateCapacityRatio: model.kind === "supply-ratio" ? model.ratio : capacityFields.immediateCapacityRatio,
    scoringCapacityUsd: capacityFields.scoringCapacityUsd,
    scoringCapacityRatio: model.kind === "supply-ratio" && !capacityFields.dailyLimitCapsCapacity ? model.ratio : capacityFields.scoringCapacityRatio,
    capacityProfile: capacityFields.capacityProfile,
    ...(model.kind === "fixed-usd" ? { capacityScoreMode: capacityFields.hasPositiveSupply ? "interpolated" as const : "tier-floor" as const } : {}),
    provider: providerId,
    sourceMode: provider.defaultSourceMode,
    resolutionState: "resolved",
    capacityConfidence,
    capacitySemantics,
    notes: model.kind === "supply-ratio" ? [] : [
      ...(capacityFields.capacityExceedsSupply
        ? ["Configured fixed USD capacity exceeds current supply; clamped to supply for scoring"]
        : []),
      ...(supplyUsd == null
        ? ["Stablecoins cache missing current supply; fixed USD capacity is visible with conservative bounded scoring"]
        : []),
      ...(capacityFields.dailyLimitCapsCapacity ? ["Documented daily limit caps usable scoring capacity"] : []),
    ],
  };
}
