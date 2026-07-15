import listingDecisionsAsset from "../../data/stablecoins/listing-decisions.json";
import listingExclusionsAsset from "../../data/stablecoins/listing-exclusions.json";
import { LISTING_CLASS_VALUES, type ListingClass } from "../../types/stablecoin-taxonomy";

export { LISTING_CLASS_VALUES, type ListingClass };

export interface ListingDecisionRegistry {
  schemaVersion: 1;
  policyVersion: string;
  listingClassById: Record<string, ListingClass>;
}

export interface ListingExclusion {
  catalogId: string;
  decidedAt: string;
  reason: string;
  providerIds: {
    coingecko?: string[];
    defillama?: string[];
  };
  contracts: Array<{ chain: string; address: string }>;
  evidence: Array<{ label: string; url: string }>;
}

export interface ListingExclusionRegistry {
  schemaVersion: 1;
  exclusions: ListingExclusion[];
}

const listingDecisions = listingDecisionsAsset as ListingDecisionRegistry;
const listingExclusions = listingExclusionsAsset as ListingExclusionRegistry;

export const LISTING_CLASS_BY_ID: ReadonlyMap<string, ListingClass> = new Map(
  Object.entries(listingDecisions.listingClassById),
);

export function getListingClass(stablecoinId: string): ListingClass | null {
  return LISTING_CLASS_BY_ID.get(stablecoinId) ?? null;
}

export const CORE_AGGREGATE_LISTING_CLASSES: ReadonlySet<ListingClass> = new Set([
  "core-stablecoin",
  "cash-equivalent",
]);

export function isCoreAggregateListingClass(listingClass: ListingClass | null | undefined): boolean {
  return listingClass != null && CORE_AGGREGATE_LISTING_CLASSES.has(listingClass);
}

export const EXCLUDED_GECKO_IDS: ReadonlySet<string> = new Set(
  listingExclusions.exclusions.flatMap((entry) => entry.providerIds.coingecko ?? []),
);

export const EXCLUDED_LLAMA_IDS: ReadonlySet<string> = new Set(
  listingExclusions.exclusions.flatMap((entry) => entry.providerIds.defillama ?? []),
);

function contractKey(chain: string, address: string): string {
  return `${chain.trim().toLowerCase()}:${address.trim().toLowerCase()}`;
}

export const EXCLUDED_CONTRACT_KEYS: ReadonlySet<string> = new Set(
  listingExclusions.exclusions.flatMap((entry) =>
    entry.contracts.map((contract) => contractKey(contract.chain, contract.address)),
  ),
);

export function isDiscoveryCandidateExcluded(candidate: {
  geckoId?: string | null;
  llamaId?: string | number | null;
  chain?: string | null;
  address?: string | null;
}): boolean {
  if (candidate.geckoId && EXCLUDED_GECKO_IDS.has(candidate.geckoId)) return true;
  if (candidate.llamaId != null && EXCLUDED_LLAMA_IDS.has(String(candidate.llamaId))) return true;
  return Boolean(
    candidate.chain && candidate.address && EXCLUDED_CONTRACT_KEYS.has(contractKey(candidate.chain, candidate.address)),
  );
}
