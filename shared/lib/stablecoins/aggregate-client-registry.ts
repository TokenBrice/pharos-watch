import type { StablecoinClientMeta } from "../../types/stablecoin-client-meta";
import { CLIENT_ACTIVE_STABLECOINS } from "./client-registry";
import { filterStablecoinsByListingClass } from "./aggregate-universe";
import { isCoreAggregateListingClass } from "./listing-governance";

const CLIENT_CORE_AGGREGATE_ACTIVE_STABLECOINS: readonly StablecoinClientMeta[] =
  CLIENT_ACTIVE_STABLECOINS.filter((stablecoin) => isCoreAggregateListingClass(stablecoin.listingClass));

export const CLIENT_CORE_AGGREGATE_ACTIVE_IDS: ReadonlySet<string> = new Set(
  CLIENT_CORE_AGGREGATE_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
);

const CLIENT_ACTIVE_VARIANT_STABLECOINS: readonly StablecoinClientMeta[] = filterStablecoinsByListingClass(
  CLIENT_ACTIVE_STABLECOINS,
  "stablecoin-variant",
);

export const CLIENT_ACTIVE_VARIANT_IDS: ReadonlySet<string> = new Set(
  CLIENT_ACTIVE_VARIANT_STABLECOINS.map((stablecoin) => stablecoin.id),
);
