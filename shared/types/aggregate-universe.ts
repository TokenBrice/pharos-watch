import { z } from "zod";

export const CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1 = "core-stablecoins-v1" as const;
export const CORE_STABLECOIN_AGGREGATE_UNIVERSE = "core-stablecoins-v2" as const;
export const CORE_STABLECOIN_AGGREGATE_UNIVERSES = [
  CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
  CORE_STABLECOIN_AGGREGATE_UNIVERSE,
] as const;

export const CoreStablecoinAggregateUniverseSchema = z.enum(CORE_STABLECOIN_AGGREGATE_UNIVERSES);
export type CoreStablecoinAggregateUniverse = z.infer<typeof CoreStablecoinAggregateUniverseSchema>;
