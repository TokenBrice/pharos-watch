import { TRACKED_STABLECOINS, TRACKED_IDS, TRACKED_META_BY_ID, FROZEN_IDS } from "./stablecoins";
import { SHADOW_STABLECOINS, SHADOW_IDS, SHADOW_META_BY_ID } from "./shadow-stablecoins";

/** All coins eligible for PSI computation = tracked + shadow, minus frozen. */
export const PSI_ELIGIBLE_IDS = new Set(
  [...TRACKED_IDS, ...SHADOW_IDS].filter((id) => !FROZEN_IDS.has(id)),
);
export const PSI_ELIGIBLE_META_BY_ID = new Map(
  [...TRACKED_META_BY_ID, ...SHADOW_META_BY_ID].filter(([id]) => !FROZEN_IDS.has(id)),
);
export const PSI_ELIGIBLE_STABLECOINS = [...TRACKED_STABLECOINS, ...SHADOW_STABLECOINS].filter(
  (coin) => !FROZEN_IDS.has(coin.id),
);
