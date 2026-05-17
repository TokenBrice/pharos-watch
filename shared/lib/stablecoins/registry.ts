import type { StablecoinMeta } from "../../types";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import perCoinGeneratedAsset from "../../data/stablecoins/coins.generated.json";
import {
  STABLECOIN_META_ASSETS_FROZEN,
  STABLECOIN_META_ASSETS_FROZEN_HASH,
} from "../../data/stablecoins/coins.frozen.generated";
import {
  findStablecoinCatalogInvariantIssues,
  parseCanonicalOrderAsset,
  parseStablecoinMetaAssets,
} from "./schema";
import {
  isActiveStablecoinMeta,
  isFrozenStablecoinMeta,
  isPreLaunchStablecoinMeta,
  isReadableStablecoinMeta,
} from "./status";
import { validateVariantRelationships } from "./validate-variants";

const CANONICAL_ORDER = parseCanonicalOrderAsset(
  canonicalOrderAsset,
  "shared/data/stablecoins/canonical-order.json",
);

/**
 * Synchronous FNV-1a 32-bit fingerprint, mirroring the generator in
 * scripts/maintenance/generate-stablecoin-frozen-registry.mjs. Runs in Node, Workers,
 * and browsers without crypto APIs. Used only to detect drift between the
 * frozen TS snapshot and the source JSON — never security-sensitive.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const sourceFingerprint = fnv1a32(JSON.stringify(perCoinGeneratedAsset));
const frozenSnapshotIsFresh = sourceFingerprint === STABLECOIN_META_ASSETS_FROZEN_HASH;

let PER_COIN_SOURCE_COINS: StablecoinMeta[];

if (frozenSnapshotIsFresh) {
  // Fast path: build-time generator + `npm run check:stablecoin-data` ran
  // Zod + invariants + variant validation against this exact JSON. Skip
  // the duplicate per-boot work.
  PER_COIN_SOURCE_COINS = STABLECOIN_META_ASSETS_FROZEN as StablecoinMeta[];
} else {
  // Drift path: someone edited a coin JSON without regenerating the frozen
  // module (typical dev hot-reload scenario). Fall back to the live Zod
  // parse + invariants so the runtime still rejects bad data.
  console.warn(
    `[stablecoin-registry] coins.generated.json fingerprint ${sourceFingerprint} ` +
      `does not match frozen snapshot ${STABLECOIN_META_ASSETS_FROZEN_HASH}; ` +
      "running live Zod validation. Run `node scripts/maintenance/generate-stablecoin-frozen-registry.mjs` to refresh.",
  );
  PER_COIN_SOURCE_COINS = parseStablecoinMetaAssets(
    perCoinGeneratedAsset,
    "shared/data/stablecoins/coins.generated.json",
  );

  const catalogInvariantIssues = findStablecoinCatalogInvariantIssues({
    canonicalOrder: CANONICAL_ORDER,
    stablecoins: PER_COIN_SOURCE_COINS,
  });

  const duplicateIdIssues = [...catalogInvariantIssues.duplicateStablecoinIds]
    .sort((a, b) => a.localeCompare(b));
  if (duplicateIdIssues.length > 0) {
    throw new Error(`coins.generated.json contains duplicate stablecoin IDs: ${duplicateIdIssues.join(", ")}`);
  }

  if (catalogInvariantIssues.duplicateCanonicalOrderIds.length > 0) {
    throw new Error(
      `canonical-order.json contains duplicate stablecoin IDs: ${catalogInvariantIssues.duplicateCanonicalOrderIds.join(", ")}`,
    );
  }

  if (catalogInvariantIssues.missingCanonicalOrderIds.length > 0) {
    throw new Error(
      `canonical-order.json is missing tracked stablecoin IDs: ${catalogInvariantIssues.missingCanonicalOrderIds.join(", ")}`,
    );
  }

  const unknownCanonicalOrderId = catalogInvariantIssues.unknownCanonicalOrderIds[0];
  if (unknownCanonicalOrderId) {
    throw new Error(`canonical-order.json references unknown stablecoin ID: ${unknownCanonicalOrderId}`);
  }
}

const byId = new Map(PER_COIN_SOURCE_COINS.map((stablecoin) => [stablecoin.id, stablecoin]));

/** Tracked stablecoins in canonical market-cap order. */
export const TRACKED_STABLECOINS: StablecoinMeta[] = CANONICAL_ORDER.map((id) => {
  const entry = byId.get(id);
  if (!entry) {
    throw new Error(`canonical-order.json references unknown stablecoin ID: ${id}`);
  }
  return entry;
});

if (!frozenSnapshotIsFresh) {
  const variantErrors = validateVariantRelationships(TRACKED_STABLECOINS);
  if (variantErrors.length > 0) {
    throw new Error(`Stablecoin variant validation failed:\n${variantErrors.join("\n")}`);
  }
}

/** Map of stablecoin ID -> metadata. Use instead of reconstructing in consumers. */
export const TRACKED_META_BY_ID = new Map(TRACKED_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]));

/** Set of all tracked stablecoin IDs. */
export const TRACKED_IDS = new Set(TRACKED_STABLECOINS.map((stablecoin) => stablecoin.id));

/**
 * Stablecoins with full worker processing. After v5.81 this strictly means
 * `status === "active"` — pre-launch coins (no past) and frozen coins (no
 * future) are both excluded from write-side crons and live aggregations.
 */
export const ACTIVE_STABLECOINS = TRACKED_STABLECOINS.filter(
  isActiveStablecoinMeta,
);

/** Set of active stablecoin IDs (excludes pre-launch and frozen). */
export const ACTIVE_IDS = new Set(ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of active stablecoin ID -> metadata. */
export const ACTIVE_META_BY_ID = new Map(
  ACTIVE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

/** Stablecoins in pre-launch stage. */
export const PRE_LAUNCH_STABLECOINS = TRACKED_STABLECOINS.filter(
  isPreLaunchStablecoinMeta,
);

/** Stablecoins in the frozen archive lifecycle phase. */
export const FROZEN_STABLECOINS = TRACKED_STABLECOINS.filter(
  isFrozenStablecoinMeta,
);

/** Set of frozen stablecoin IDs. */
export const FROZEN_IDS = new Set(FROZEN_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of frozen stablecoin ID -> metadata. */
export const FROZEN_META_BY_ID = new Map(
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
export const READABLE_STABLECOINS = TRACKED_STABLECOINS.filter(
  isReadableStablecoinMeta,
);

/** Set of readable stablecoin IDs (active + frozen). */
export const READABLE_IDS = new Set(READABLE_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of readable stablecoin ID -> metadata. */
export const READABLE_META_BY_ID = new Map(
  READABLE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);
