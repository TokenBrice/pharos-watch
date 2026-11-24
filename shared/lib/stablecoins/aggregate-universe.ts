import {
  getListingClass,
  isCoreAggregateListingClass,
  isTokenizedFundId,
  type ListingClass,
} from "./listing-governance";
import {
  CORE_STABLECOIN_AGGREGATE_UNIVERSE,
  CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
  CORE_STABLECOIN_AGGREGATE_UNIVERSES,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
  CoreStablecoinAggregateUniverseSchema,
  getCoreAggregateUniverseForTimestamp,
  type CoreStablecoinAggregateUniverse,
} from "../../types/aggregate-universe";

export {
  CORE_STABLECOIN_AGGREGATE_UNIVERSE,
  CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
  CORE_STABLECOIN_AGGREGATE_UNIVERSES,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
  CoreStablecoinAggregateUniverseSchema,
  getCoreAggregateUniverseForTimestamp,
  type CoreStablecoinAggregateUniverse,
};

interface StablecoinIdentity {
  id: string;
}

export function isCoreAggregateStablecoinId(stablecoinId: string): boolean {
  return isCoreAggregateListingClass(getListingClass(stablecoinId));
}

function hasListingClass(stablecoinId: string, listingClass: ListingClass): boolean {
  return getListingClass(stablecoinId) === listingClass;
}

export function filterCoreAggregateStablecoins<T extends StablecoinIdentity>(rows: readonly T[]): T[] {
  return rows.filter((row) => isCoreAggregateStablecoinId(row.id));
}

export function filterTokenizedFunds<T extends StablecoinIdentity>(rows: readonly T[]): T[] {
  return rows.filter((row) => isTokenizedFundId(row.id));
}

export function filterStablecoinsByListingClass<T extends StablecoinIdentity>(
  rows: readonly T[],
  listingClass: ListingClass,
): T[] {
  return rows.filter((row) => hasListingClass(row.id, listingClass));
}
