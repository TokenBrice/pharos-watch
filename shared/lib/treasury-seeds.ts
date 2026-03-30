import treasurySeedsAsset from "../data/treasury-seeds.json";
import {
  TreasurySeedRegistrySchema,
  type TreasurySeed,
} from "../types/treasury-stable-exposure";

export const TREASURY_SEEDS: TreasurySeed[] = TreasurySeedRegistrySchema.parse(treasurySeedsAsset);

export const TREASURY_LAUNCH_SEEDS = TREASURY_SEEDS
  .filter((seed) => seed.launchEligible)
  .sort((a, b) => (a.launchPriority ?? Number.MAX_SAFE_INTEGER) - (b.launchPriority ?? Number.MAX_SAFE_INTEGER));
