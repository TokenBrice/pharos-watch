import { getListingClass, isCoreAggregateListingClass, type ListingClass } from "./listing-governance";

export const CORE_STABLECOIN_AGGREGATE_UNIVERSE = "core-stablecoins-v1" as const;
export type CoreStablecoinAggregateUniverse = typeof CORE_STABLECOIN_AGGREGATE_UNIVERSE;

interface StablecoinIdentity {
  id: string;
}

export function isCoreAggregateStablecoinId(stablecoinId: string): boolean {
  return isCoreAggregateListingClass(getListingClass(stablecoinId));
}

export function hasListingClass(stablecoinId: string, listingClass: ListingClass): boolean {
  return getListingClass(stablecoinId) === listingClass;
}

export function filterCoreAggregateStablecoins<T extends StablecoinIdentity>(rows: readonly T[]): T[] {
  return rows.filter((row) => isCoreAggregateStablecoinId(row.id));
}

export function filterStablecoinsByListingClass<T extends StablecoinIdentity>(
  rows: readonly T[],
  listingClass: ListingClass,
): T[] {
  return rows.filter((row) => hasListingClass(row.id, listingClass));
}

export function filterRowsByStablecoinIds<T extends StablecoinIdentity>(
  rows: readonly T[],
  stablecoinIds: ReadonlySet<string>,
): T[] {
  return rows.filter((row) => stablecoinIds.has(row.id));
}
