import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import {
  resolveCapacityBasis,
  resolveReserveSyncCapacityConfidence,
  type CapacityResolution,
  type CapacityResolverContext,
  type RedemptionBackstopBuildOptions,
} from "../redemption-backstop-capacity/profile";
import { resolveFixedUsdCapacity } from "../redemption-backstop-capacity/fixed-usd";
import { resolveReserveSyncCapacity } from "../redemption-backstop-capacity/reserve-sync";
import { resolveSupplyFullCapacity } from "../redemption-backstop-capacity/supply-full";
import { resolveSupplyRatioCapacity } from "../redemption-backstop-capacity/supply-ratio";

export {
  resolveCapacityBasis,
  resolveReserveSyncCapacityConfidence,
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
  switch (model.kind) {
    case "supply-full":
      return resolveSupplyFullCapacity(model, context);
    case "supply-ratio":
      return resolveSupplyRatioCapacity(model, context);
    case "fixed-usd":
      return resolveFixedUsdCapacity(model, context);
    case "reserve-sync-metadata":
      return resolveReserveSyncCapacity(model, context);
    default:
      return model satisfies never;
  }
}
