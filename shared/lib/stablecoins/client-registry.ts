import type { StablecoinClientMeta } from "../../types/stablecoin-client-meta";
import perCoinClientAsset from "../../data/stablecoins/coins.client.generated.json";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import {
  isActiveStablecoinMeta,
  isFrozenStablecoinMeta,
  isPreLaunchStablecoinMeta,
  isReadableStablecoinMeta,
} from "./status";

/**
 * Client-side slim stablecoin registry.
 *
 * Mirrors the shape of `shared/lib/stablecoins/registry.ts` but ships only
 * the fields enumerated in `StablecoinClientMeta`. The full registry stays
 * for server callers that need `reserves`, `contracts`, `dependencies`,
 * `blacklistabilityReview`, obituary text, etc.
 *
 * Source-of-truth pipeline:
 *   `coins.generated.json` (1.37 MiB, full)
 *     -> `scripts/build-data/build-client-registry.mjs`
 *     -> `coins.client.generated.json` (~280 KiB, slim)
 *     -> this module
 *
 * `validate-client-registry-fields` (CI) keeps the slim projection a strict
 * subset of the full asset; `build-client-registry.mjs --check` keeps the
 * checked-in slim JSON byte-identical to a fresh generation.
 */

const CLIENT_COINS_BY_ID = new Map<string, StablecoinClientMeta>();
for (const entry of perCoinClientAsset as StablecoinClientMeta[]) {
  CLIENT_COINS_BY_ID.set(entry.id, entry);
}

const CANONICAL_ORDER = canonicalOrderAsset as string[];

/** Tracked stablecoins in canonical market-cap order (slim projection). */
export const CLIENT_TRACKED_STABLECOINS: StablecoinClientMeta[] = CANONICAL_ORDER.map(
  (id) => {
    const entry = CLIENT_COINS_BY_ID.get(id);
    if (!entry) {
      throw new Error(
        `[client-registry] canonical-order.json references unknown stablecoin ID: ${id}`,
      );
    }
    return entry;
  },
);

/** Map of stablecoin ID -> slim metadata. */
export const CLIENT_TRACKED_META_BY_ID = new Map(
  CLIENT_TRACKED_STABLECOINS.map((entry) => [entry.id, entry] as const),
);

/** Set of all tracked stablecoin IDs. */
export const CLIENT_TRACKED_IDS = new Set(
  CLIENT_TRACKED_STABLECOINS.map((entry) => entry.id),
);

/** Active stablecoins (excludes pre-launch and frozen). */
export const CLIENT_ACTIVE_STABLECOINS: StablecoinClientMeta[] =
  CLIENT_TRACKED_STABLECOINS.filter(isActiveStablecoinMeta);

/** Set of active stablecoin IDs. */
export const CLIENT_ACTIVE_IDS = new Set(
  CLIENT_ACTIVE_STABLECOINS.map((entry) => entry.id),
);

/** Map of active stablecoin ID -> slim metadata. */
export const CLIENT_ACTIVE_META_BY_ID = new Map(
  CLIENT_ACTIVE_STABLECOINS.map((entry) => [entry.id, entry] as const),
);

/** Pre-launch stablecoins (slim projection). */
export const CLIENT_PRE_LAUNCH_STABLECOINS: StablecoinClientMeta[] =
  CLIENT_TRACKED_STABLECOINS.filter(isPreLaunchStablecoinMeta);

/** Frozen stablecoins (slim projection). */
export const CLIENT_FROZEN_STABLECOINS: StablecoinClientMeta[] =
  CLIENT_TRACKED_STABLECOINS.filter(isFrozenStablecoinMeta);

/** Set of frozen stablecoin IDs. */
export const CLIENT_FROZEN_IDS = new Set(
  CLIENT_FROZEN_STABLECOINS.map((entry) => entry.id),
);

/** Map of frozen stablecoin ID -> slim metadata. */
export const CLIENT_FROZEN_META_BY_ID = new Map(
  CLIENT_FROZEN_STABLECOINS.map((entry) => [entry.id, entry] as const),
);

/** Readable stablecoins (active + frozen; slim projection). */
export const CLIENT_READABLE_STABLECOINS: StablecoinClientMeta[] =
  CLIENT_TRACKED_STABLECOINS.filter(isReadableStablecoinMeta);

/** Set of readable stablecoin IDs (active + frozen). */
export const CLIENT_READABLE_IDS = new Set(
  CLIENT_READABLE_STABLECOINS.map((entry) => entry.id),
);

/** Map of readable stablecoin ID -> slim metadata. */
export const CLIENT_READABLE_META_BY_ID = new Map(
  CLIENT_READABLE_STABLECOINS.map((entry) => [entry.id, entry] as const),
);

export type { StablecoinClientMeta } from "../../types/stablecoin-client-meta";
