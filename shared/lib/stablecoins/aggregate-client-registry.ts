import type { StablecoinClientMeta } from "../../types/stablecoin-client-meta";
import { CLIENT_ACTIVE_STABLECOINS } from "./client-registry";

const CLIENT_CORE_AGGREGATE_ACTIVE_STABLECOINS: readonly StablecoinClientMeta[] =
  CLIENT_ACTIVE_STABLECOINS.filter(
    (stablecoin) => stablecoin.listingClass === "core-stablecoin" || stablecoin.listingClass === "cash-equivalent",
  );

export const CLIENT_CORE_AGGREGATE_ACTIVE_IDS: ReadonlySet<string> = new Set(
  CLIENT_CORE_AGGREGATE_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
);

const CLIENT_ACTIVE_VARIANT_STABLECOINS: readonly StablecoinClientMeta[] = CLIENT_ACTIVE_STABLECOINS.filter(
  (stablecoin) => stablecoin.listingClass === "stablecoin-variant",
);

export const CLIENT_ACTIVE_VARIANT_IDS: ReadonlySet<string> = new Set(
  CLIENT_ACTIVE_VARIANT_STABLECOINS.map((stablecoin) => stablecoin.id),
);

const CLIENT_ACTIVE_STABLE_VALUE_INVESTMENTS: readonly StablecoinClientMeta[] = CLIENT_ACTIVE_STABLECOINS.filter(
  (stablecoin) => stablecoin.listingClass === "stable-value-investment",
);

const CLIENT_ACTIVE_STABLE_VALUE_INVESTMENT_IDS: ReadonlySet<string> = new Set(
  CLIENT_ACTIVE_STABLE_VALUE_INVESTMENTS.map((stablecoin) => stablecoin.id),
);
