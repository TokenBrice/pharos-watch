import type { StablecoinMeta } from "../../types";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import { STABLECOIN_META_ASSETS_PREVALIDATED } from "../../data/stablecoins/coins.prevalidated.generated";
import {
  isActiveStablecoinMeta,
  isFrozenStablecoinMeta,
  isPreLaunchStablecoinMeta,
  isReadableStablecoinMeta,
} from "./status";

const CANONICAL_ORDER = canonicalOrderAsset as readonly string[];
const PER_COIN_SOURCE_COINS = STABLECOIN_META_ASSETS_PREVALIDATED as readonly StablecoinMeta[];

const byId = new Map(PER_COIN_SOURCE_COINS.map((stablecoin) => [stablecoin.id, stablecoin]));

/** Tracked stablecoins in canonical market-cap order. */
export const TRACKED_STABLECOINS: readonly StablecoinMeta[] = CANONICAL_ORDER.map((id) => {
  const entry = byId.get(id);
  if (!entry) {
    throw new Error(`canonical-order.json references unknown stablecoin ID: ${id}`);
  }
  return entry;
});

/** Map of stablecoin ID -> metadata. Use instead of reconstructing in consumers. */
export const TRACKED_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = new Map(
  TRACKED_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

/** Set of all tracked stablecoin IDs. */
export const TRACKED_IDS: ReadonlySet<string> = new Set(TRACKED_STABLECOINS.map((stablecoin) => stablecoin.id));

/**
 * Stablecoins with full worker processing. After v5.81 this strictly means
 * `status === "active"` — pre-launch coins (no past) and frozen coins (no
 * future) are both excluded from write-side crons and live aggregations.
 */
export const ACTIVE_STABLECOINS: readonly StablecoinMeta[] = TRACKED_STABLECOINS.filter(
  isActiveStablecoinMeta,
);

/** Set of active stablecoin IDs (excludes pre-launch and frozen). */
export const ACTIVE_IDS: ReadonlySet<string> = new Set(ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of active stablecoin ID -> metadata. */
export const ACTIVE_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = new Map(
  ACTIVE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

/** Stablecoins in pre-launch stage. */
export const PRE_LAUNCH_STABLECOINS: readonly StablecoinMeta[] = TRACKED_STABLECOINS.filter(
  isPreLaunchStablecoinMeta,
);

/** Stablecoins in the frozen archive lifecycle phase. */
export const FROZEN_STABLECOINS: readonly StablecoinMeta[] = TRACKED_STABLECOINS.filter(
  isFrozenStablecoinMeta,
);

/** Set of frozen stablecoin IDs. */
export const FROZEN_IDS: ReadonlySet<string> = new Set(FROZEN_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of frozen stablecoin ID -> metadata. */
export const FROZEN_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = new Map(
  FROZEN_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

/**
 * Stablecoins whose data the site reads back (active + frozen). Use for:
 * sitemap, search, compare picker, API endpoints serving the frozen detail
 * page (`stablecoin-reserves`, `stress-signals`, `og`), rebuild caches,
 * `/api/stablecoins` payload composition.
 *
 * Pre-launch coins are excluded — they have no historical data to read.
 */
export const READABLE_STABLECOINS: readonly StablecoinMeta[] = TRACKED_STABLECOINS.filter(
  isReadableStablecoinMeta,
);

/** Set of readable stablecoin IDs (active + frozen). */
export const READABLE_IDS: ReadonlySet<string> = new Set(READABLE_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of readable stablecoin ID -> metadata. */
export const READABLE_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = new Map(
  READABLE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);
