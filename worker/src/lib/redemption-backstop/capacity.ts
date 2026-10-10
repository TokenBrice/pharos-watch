import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
} from "@shared/lib/redemption-backstop-providers";
import {
  resolveCapacityBasis,
  type CapacityResolution,
  type CapacityResolverContext,
  type RedemptionBackstopBuildOptions,
} from "../redemption-backstop-capacity/profile";
import { resolveStaticCapacity } from "../redemption-backstop-capacity/static";
import { resolveReserveSyncCapacity } from "../redemption-backstop-capacity/reserve-sync";
import { resolveExecutableObserverCapacity } from "../redemption-backstop-capacity/executable-observer";

export {
  resolveCapacityBasis,
  type CapacityResolution,
  type RedemptionBackstopBuildOptions,
};

export async function resolveRedemptionCapacity(
  db: D1Database,
  stablecoinId: string,
  model: RedemptionCapacityModel,
  supplyUsd: number | null,
  now: number,
  options: RedemptionBackstopBuildOptions = {},
): Promise<CapacityResolution> {
  const context: CapacityResolverContext = { db, stablecoinId, supplyUsd, now, options };
  // Exhaustive dispatch: adding a RedemptionCapacityModel kind without a
  // resolver case fails typecheck via the `satisfies never` default.
  // Static resolvers return synchronously; this boundary owns the public Promise.
  switch (model.kind) {
    case "unquantified": {
      const provider = REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.UNQUANTIFIED_MODEL];
      return {
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        scoringCapacityUsd: null,
        scoringCapacityRatio: null,
        eventualCapacityUsd: null,
        eventualCapacityRatio: null,
        capacityProfile: {
          immediateUsd: null,
          eventualUsd: null,
          scoringUsd: null,
          scoringHorizon: "unknown",
          capacityProfileConfidence: provider.defaultCapacityConfidence,
        },
        provider: provider.id,
        sourceMode: provider.defaultSourceMode,
        resolutionState: "missing-capacity",
        capacityConfidence: provider.defaultCapacityConfidence,
        capacitySemantics: provider.defaultCapacitySemantics,
        notes: ["redemption-capacity-unquantified"],
      };
    }
    case "supply-full":
    case "supply-ratio":
    case "fixed-usd":
      return resolveStaticCapacity(model, context);
    case "reserve-sync-metadata":
      return resolveReserveSyncCapacity(model, context);
    case "executable-observer":
      return resolveExecutableObserverCapacity(model, context);
    default:
      return model satisfies never;
  }
}
