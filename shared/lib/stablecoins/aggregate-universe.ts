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
  CoreStablecoinAggregateUniverseSchema,
  type CoreStablecoinAggregateUniverse,
} from "../../types/aggregate-universe";

export {
  CORE_STABLECOIN_AGGREGATE_UNIVERSE,
  CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
  CORE_STABLECOIN_AGGREGATE_UNIVERSES,
  CoreStablecoinAggregateUniverseSchema,
  type CoreStablecoinAggregateUniverse,
};

/**
 * Single cutover-date authority (UTC YYYY-MM-DD, effective 00:00:00Z) for the
 * listing-policy v2 core aggregate switch (`core-stablecoins-v1` -> `core-stablecoins-v2`).
 * Historical dates strictly before this instant keep the frozen v1 membership;
 * dates from this instant onward use the v2 core aggregate.
 */
export const CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE = "2026-11-26" as const;
export const CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC =
  Date.parse(`${CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE}T00:00:00Z`) / 1000;

export function getCoreAggregateUniverseForTimestamp(timestampSec: number): CoreStablecoinAggregateUniverse {
  return timestampSec < CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC
    ? CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1
    : CORE_STABLECOIN_AGGREGATE_UNIVERSE;
}

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
