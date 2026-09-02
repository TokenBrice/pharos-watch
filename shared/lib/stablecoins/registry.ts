import type { StablecoinMeta } from "../../types";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import coinsGeneratedAsset from "../../data/stablecoins/coins.generated.json";
import {
  isActiveStablecoinMeta,
  isDelistedStablecoinMeta,
  isFrozenStablecoinMeta,
  isPreLaunchStablecoinMeta,
  isQuarantinedStablecoinMeta,
  isReadableStablecoinMeta,
} from "./status";
import { buildStablecoinRegistryIndexes } from "./registry-indexes";

const CANONICAL_ORDER = canonicalOrderAsset as readonly string[];
// `coins.generated.json` is emitted by the catalog generator, which parses every
// source file through the full Zod registry schema first. Casting here keeps the
// validator out of browser-facing chunks; `npm run check:stablecoin-data` is the
// authoritative validation of the artifact.
const PER_COIN_SOURCE_COINS = coinsGeneratedAsset as unknown as readonly StablecoinMeta[];

// A `liveReservesConfig.suspended` marker is an operator kill switch for a dead
// or semantically unusable upstream feed. Stripping the config here — the
// single ingestion point — makes every consumer (sync queue, V9
// backing evidence, presentation, breakers) treat the coin as having no live
// feed, which is the supported curated-fallback state. The source file keeps
// the adapter config so re-enabling is a one-line revert.
/** @internal Exported for the registry suspension test. */
export function withoutSuspendedLiveReserves(stablecoin: StablecoinMeta): StablecoinMeta {
  if (!stablecoin.liveReservesConfig?.suspended) return stablecoin;
  const { liveReservesConfig: _suspendedConfig, ...rest } = stablecoin;
  return rest;
}

const registry = buildStablecoinRegistryIndexes(PER_COIN_SOURCE_COINS, {
  canonicalOrder: CANONICAL_ORDER,
  normalize: withoutSuspendedLiveReserves,
  isActive: isActiveStablecoinMeta,
  lifecyclePredicates: {
    preLaunch: isPreLaunchStablecoinMeta,
    frozen: isFrozenStablecoinMeta,
    quarantined: isQuarantinedStablecoinMeta,
    delisted: isDelistedStablecoinMeta,
    readable: isReadableStablecoinMeta,
  },
});

/** Tracked stablecoins in canonical market-cap order. */
export const TRACKED_STABLECOINS: readonly StablecoinMeta[] = registry.tracked.stablecoins;

/** Map of stablecoin ID -> metadata. Use instead of reconstructing in consumers. */
export const TRACKED_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = registry.tracked.metaById;

/** Set of all tracked stablecoin IDs. */
export const TRACKED_IDS: ReadonlySet<string> = registry.tracked.ids;

/**
 * Stablecoins with full worker processing. After v5.81 this strictly means
 * `status === "active"` (or omitted). Pre-launch, quarantined, delisted, and
 * frozen coins are excluded from write-side crons and live aggregations.
 */
export const ACTIVE_STABLECOINS: readonly StablecoinMeta[] = registry.active.stablecoins;

/** Set of active stablecoin IDs. */
export const ACTIVE_IDS: ReadonlySet<string> = registry.active.ids;

/** Map of active stablecoin ID -> metadata. */
export const ACTIVE_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = registry.active.metaById;

/** Stablecoins in pre-launch stage. */
export const PRE_LAUNCH_STABLECOINS: readonly StablecoinMeta[] = registry.lifecycle.preLaunch.stablecoins;

/** Stablecoins in the frozen archive lifecycle phase. */
export const FROZEN_STABLECOINS: readonly StablecoinMeta[] = registry.lifecycle.frozen.stablecoins;

/** Set of frozen stablecoin IDs. */
export const FROZEN_IDS: ReadonlySet<string> = registry.lifecycle.frozen.ids;

/** Map of frozen stablecoin ID -> metadata. */
export const FROZEN_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = registry.lifecycle.frozen.metaById;

/** Assets temporarily withheld from live publication pending a reviewed fix. */
export const QUARANTINED_STABLECOINS: readonly StablecoinMeta[] = registry.lifecycle.quarantined.stablecoins;

export const QUARANTINED_IDS: ReadonlySet<string> = registry.lifecycle.quarantined.ids;

export const QUARANTINED_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = registry.lifecycle.quarantined.metaById;

/** Out-of-scope assets retained only for historical identity and readback. */
export const DELISTED_STABLECOINS: readonly StablecoinMeta[] = registry.lifecycle.delisted.stablecoins;

export const DELISTED_IDS: ReadonlySet<string> = registry.lifecycle.delisted.ids;

export const DELISTED_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = registry.lifecycle.delisted.metaById;

/**
 * Stablecoins whose checked-in identity remains readable after launch (active +
 * quarantined + delisted + frozen). Use for historical/read-only surfaces such
 * as sitemap, search, canonical-ID redirects, and preserved detail routes. Live
 * cache publication and provider collection must use the active registry.
 *
 * Pre-launch coins are excluded — they have no historical data to read.
 */
export const READABLE_STABLECOINS: readonly StablecoinMeta[] = registry.lifecycle.readable.stablecoins;

/** Set of readable stablecoin IDs (all post-launch lifecycle states). */
export const READABLE_IDS: ReadonlySet<string> = registry.lifecycle.readable.ids;

/** Map of readable stablecoin ID -> metadata. */
export const READABLE_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = registry.lifecycle.readable.metaById;
