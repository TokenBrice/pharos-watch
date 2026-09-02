import type { StablecoinClientMeta } from "../../types/stablecoin-client-meta";
import perCoinClientAsset from "../../data/stablecoins/coins.client.generated.json";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import { buildStablecoinRegistryIndexes } from "./registry-indexes";
import { isActiveStablecoinMeta } from "./status";

/**
 * Client-side slim stablecoin registry.
 *
 * Mirrors the shape of `shared/lib/stablecoins/registry.ts` but ships only
 * the fields enumerated in `StablecoinClientMeta`. The full registry stays
 * for server callers that need `contracts`, `dependencies`,
 * `blacklistabilityReview`, obituary text, etc.
 *
 * Source-of-truth pipeline:
 *   `coins.generated.json` (full generated registry)
 *     -> `scripts/build-data/build-client-registry.mjs`
 *     -> `coins.client.generated.json` (client projection)
 *     -> this module
 *
 * `build-client-registry.mjs --check` keeps the checked-in slim JSON
 * byte-identical to a fresh generation, and the client-registry field contract
 * tests keep the projection aligned with the full asset.
 */

const CANONICAL_ORDER = canonicalOrderAsset as readonly string[];
const registry = buildStablecoinRegistryIndexes(perCoinClientAsset as StablecoinClientMeta[], {
  canonicalOrder: CANONICAL_ORDER,
  isActive: isActiveStablecoinMeta,
  canonicalOrderErrorPrefix: "[client-registry] ",
});

/** Tracked stablecoins in canonical market-cap order (slim projection). */
export const CLIENT_TRACKED_STABLECOINS: readonly StablecoinClientMeta[] = registry.tracked.stablecoins;

/** Map of stablecoin ID -> slim metadata. */
export const CLIENT_TRACKED_META_BY_ID: ReadonlyMap<string, StablecoinClientMeta> = registry.tracked.metaById;

/** Set of all tracked stablecoin IDs, across every lifecycle state. */
export const CLIENT_TRACKED_IDS: ReadonlySet<string> = registry.tracked.ids;

/** Active stablecoins (excludes every non-active lifecycle state). */
export const CLIENT_ACTIVE_STABLECOINS: readonly StablecoinClientMeta[] = registry.active.stablecoins;

/** Set of active stablecoin IDs. */
export const CLIENT_ACTIVE_IDS: ReadonlySet<string> = registry.active.ids;

/** Map of active stablecoin ID -> slim metadata. */
export const CLIENT_ACTIVE_META_BY_ID: ReadonlyMap<string, StablecoinClientMeta> = registry.active.metaById;

export type { StablecoinClientMeta } from "../../types/stablecoin-client-meta";
