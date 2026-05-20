import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import {
  resolveCapacityBasis,
  resolveReserveSyncCapacityConfidence,
  type CapacityResolution,
  type CapacityResolver,
  type CapacityResolverContext,
  type RedemptionBackstopBuildOptions,
} from "./redemption-backstop-capacity/profile";
import { resolveFixedUsdCapacity } from "./redemption-backstop-capacity/fixed-usd";
import { resolveReserveSyncCapacity } from "./redemption-backstop-capacity/reserve-sync";
import { resolveSupplyFullCapacity } from "./redemption-backstop-capacity/supply-full";
import { resolveSupplyRatioCapacity } from "./redemption-backstop-capacity/supply-ratio";

export {
  resolveCapacityBasis,
  resolveReserveSyncCapacityConfidence,
  type CapacityResolution,
  type RedemptionBackstopBuildOptions,
};

const RESOLVERS: { [K in RedemptionCapacityModel["kind"]]: CapacityResolver<Extract<RedemptionCapacityModel, { kind: K }>> } = {
  "supply-full": resolveSupplyFullCapacity,
  "supply-ratio": resolveSupplyRatioCapacity,
  "fixed-usd": resolveFixedUsdCapacity,
  "reserve-sync-metadata": resolveReserveSyncCapacity,
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
  const resolver = RESOLVERS[model.kind] as CapacityResolver;
  return resolver(model, context);
}
