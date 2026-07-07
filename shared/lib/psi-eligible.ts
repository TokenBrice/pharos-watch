import { ACTIVE_STABLECOINS, ACTIVE_IDS, ACTIVE_META_BY_ID } from "./stablecoins/registry";
import { SHADOW_STABLECOINS, SHADOW_IDS, SHADOW_META_BY_ID } from "./shadow-stablecoins";
import type { StablecoinMeta } from "../types";

/** All coins eligible for PSI computation = active tracked + shadow. */
export const PSI_ELIGIBLE_IDS: ReadonlySet<string> = new Set(
  [...ACTIVE_IDS, ...SHADOW_IDS],
);
export const PSI_ELIGIBLE_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = new Map(
  [...ACTIVE_META_BY_ID, ...SHADOW_META_BY_ID],
);
export const PSI_ELIGIBLE_STABLECOINS: readonly StablecoinMeta[] = [...ACTIVE_STABLECOINS, ...SHADOW_STABLECOINS];
