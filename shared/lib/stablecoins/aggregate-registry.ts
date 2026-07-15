import type { StablecoinMeta } from "../../types";
import { ACTIVE_STABLECOINS } from "./registry";
import { filterCoreAggregateStablecoins, filterStablecoinsByListingClass } from "./aggregate-universe";

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

export const ACTIVE_STABLE_VALUE_INVESTMENTS: readonly StablecoinMeta[] = filterStablecoinsByListingClass(
  ACTIVE_STABLECOINS,
  "stable-value-investment",
);

export const ACTIVE_STABLE_VALUE_INVESTMENT_IDS: ReadonlySet<string> = new Set(
  ACTIVE_STABLE_VALUE_INVESTMENTS.map((stablecoin) => stablecoin.id),
);
