import type { StablecoinClientMeta } from "../../types/stablecoin-client-meta";
import { CLIENT_ACTIVE_STABLECOINS, CLIENT_TRACKED_META_BY_ID } from "./client-registry";
import { isCoreAggregateListingClass, isTokenizedFundListingClass } from "./listing-class";

const CLIENT_CORE_AGGREGATE_ACTIVE_STABLECOINS: readonly StablecoinClientMeta[] =
  CLIENT_ACTIVE_STABLECOINS.filter((stablecoin) => isCoreAggregateListingClass(stablecoin.listingClass));

export const CLIENT_CORE_AGGREGATE_ACTIVE_IDS: ReadonlySet<string> = new Set(
  CLIENT_CORE_AGGREGATE_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
);

const CLIENT_ACTIVE_VARIANT_STABLECOINS: readonly StablecoinClientMeta[] =
  CLIENT_ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.listingClass === "stablecoin-variant");

export const CLIENT_ACTIVE_VARIANT_IDS: ReadonlySet<string> = new Set(
  CLIENT_ACTIVE_VARIANT_STABLECOINS.map((stablecoin) => stablecoin.id),
);

const CLIENT_ACTIVE_TOKENIZED_FUNDS: readonly StablecoinClientMeta[] =
  CLIENT_ACTIVE_STABLECOINS.filter((stablecoin) => isTokenizedFundListingClass(stablecoin.listingClass));

export const CLIENT_ACTIVE_TOKENIZED_FUND_IDS: ReadonlySet<string> = new Set(
  CLIENT_ACTIVE_TOKENIZED_FUNDS.map((stablecoin) => stablecoin.id),
);

/**
 * Client-safe tokenized-fund check backed by the compact client registry's
 * `listingClass`, avoiding the server-only listing-decisions ledger in client bundles.
 */
export function isClientTokenizedFundId(id: string): boolean {
  return isTokenizedFundListingClass(CLIENT_TRACKED_META_BY_ID.get(id)?.listingClass);
}

/**
 * Active tracked stablecoins excluding tokenized funds: core stablecoins,
 * tracked variants, and review-hold coins. Used for "All" stablecoin views.
 */
const CLIENT_ACTIVE_ALL_STABLECOINS: readonly StablecoinClientMeta[] =
  CLIENT_ACTIVE_STABLECOINS.filter((stablecoin) => !isTokenizedFundListingClass(stablecoin.listingClass));

export const CLIENT_ACTIVE_ALL_STABLECOIN_IDS: ReadonlySet<string> = new Set(
  CLIENT_ACTIVE_ALL_STABLECOINS.map((stablecoin) => stablecoin.id),
);
