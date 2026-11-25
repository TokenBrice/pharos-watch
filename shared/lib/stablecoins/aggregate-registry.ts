import type { StablecoinMeta } from "../../types/stablecoin-meta-schemas";
import { ACTIVE_STABLECOINS } from "./registry";
import {
  filterCoreAggregateStablecoins,
  filterStablecoinsByListingClass,
  filterTokenizedFunds,
} from "./aggregate-universe";

export const CORE_AGGREGATE_ACTIVE_STABLECOINS: readonly StablecoinMeta[] =
  filterCoreAggregateStablecoins(ACTIVE_STABLECOINS);

export const CORE_AGGREGATE_ACTIVE_IDS: ReadonlySet<string> = new Set(
  CORE_AGGREGATE_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
);

export const CORE_AGGREGATE_ACTIVE_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = new Map(
  CORE_AGGREGATE_ACTIVE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

export const ACTIVE_VARIANT_STABLECOINS: readonly StablecoinMeta[] = filterStablecoinsByListingClass(
  ACTIVE_STABLECOINS,
  "stablecoin-variant",
);

export const ACTIVE_VARIANT_IDS: ReadonlySet<string> = new Set(
  ACTIVE_VARIANT_STABLECOINS.map((stablecoin) => stablecoin.id),
);

export const ACTIVE_TOKENIZED_FUNDS: readonly StablecoinMeta[] = filterTokenizedFunds(ACTIVE_STABLECOINS);

export const ACTIVE_TOKENIZED_FUND_IDS: ReadonlySet<string> = new Set(
  ACTIVE_TOKENIZED_FUNDS.map((stablecoin) => stablecoin.id),
);

export const ACTIVE_REVIEW_HOLD_STABLECOINS: readonly StablecoinMeta[] = filterStablecoinsByListingClass(
  ACTIVE_STABLECOINS,
  "review-hold",
);

export const ACTIVE_REVIEW_HOLD_IDS: ReadonlySet<string> = new Set(
  ACTIVE_REVIEW_HOLD_STABLECOINS.map((stablecoin) => stablecoin.id),
);
