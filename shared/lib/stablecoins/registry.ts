import type { StablecoinMeta } from "../../types";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import perCoinGeneratedAsset from "../../data/stablecoins/coins.generated.json";
import {
  parseCanonicalOrderAsset,
  parseStablecoinMetaAssets,
} from "./schema";
import { validateVariantRelationships } from "./validate-variants";

const CANONICAL_ORDER = parseCanonicalOrderAsset(
  canonicalOrderAsset,
  "shared/data/stablecoins/canonical-order.json",
);

const PER_COIN_SOURCE_COINS: StablecoinMeta[] = parseStablecoinMetaAssets(
  perCoinGeneratedAsset,
  "shared/data/stablecoins/coins.generated.json",
);

const duplicateIdIssues = [...PER_COIN_SOURCE_COINS.reduce((counts, stablecoin) => {
  counts.set(stablecoin.id, (counts.get(stablecoin.id) ?? 0) + 1);
  return counts;
}, new Map<string, number>()).entries()]
  .filter(([, count]) => count > 1)
  .map(([id]) => id)
  .sort((a, b) => a.localeCompare(b));

if (duplicateIdIssues.length > 0) {
  throw new Error(`coins.generated.json contains duplicate stablecoin IDs: ${duplicateIdIssues.join(", ")}`);
}

const byId = new Map(PER_COIN_SOURCE_COINS.map((stablecoin) => [stablecoin.id, stablecoin]));
const canonicalOrderSeen = new Set<string>();
const duplicateCanonicalOrderIds: string[] = [];

for (const id of CANONICAL_ORDER) {
  if (canonicalOrderSeen.has(id)) {
    duplicateCanonicalOrderIds.push(id);
    continue;
  }
  canonicalOrderSeen.add(id);
}

if (duplicateCanonicalOrderIds.length > 0) {
  throw new Error(
    `canonical-order.json contains duplicate stablecoin IDs: ${[...new Set(duplicateCanonicalOrderIds)].join(", ")}`,
  );
}

const missingCanonicalOrderIds = PER_COIN_SOURCE_COINS
  .map((stablecoin) => stablecoin.id)
  .filter((id, index, ids) => ids.indexOf(id) === index && !canonicalOrderSeen.has(id));

if (missingCanonicalOrderIds.length > 0) {
  throw new Error(
    `canonical-order.json is missing tracked stablecoin IDs: ${missingCanonicalOrderIds.join(", ")}`,
  );
}

/** Tracked stablecoins in canonical market-cap order. */
export const TRACKED_STABLECOINS: StablecoinMeta[] = CANONICAL_ORDER.map((id) => {
  const entry = byId.get(id);
  if (!entry) {
    throw new Error(`canonical-order.json references unknown stablecoin ID: ${id}`);
  }
  return entry;
});

const variantErrors = validateVariantRelationships(TRACKED_STABLECOINS);
if (variantErrors.length > 0) {
  throw new Error(`Stablecoin variant validation failed:\n${variantErrors.join("\n")}`);
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
  (stablecoin) => stablecoin.status !== "pre-launch" && stablecoin.status !== "frozen",
);

/** Set of active stablecoin IDs (excludes pre-launch and frozen). */
export const ACTIVE_IDS = new Set(ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of active stablecoin ID -> metadata. */
export const ACTIVE_META_BY_ID = new Map(
  ACTIVE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

/** Stablecoins in pre-launch stage. */
export const PRE_LAUNCH_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.status === "pre-launch",
);

/** Stablecoins in the frozen archive lifecycle phase. */
export const FROZEN_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.status === "frozen",
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
  (stablecoin) => stablecoin.status !== "pre-launch",
);

/** Set of readable stablecoin IDs (active + frozen). */
export const READABLE_IDS = new Set(READABLE_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of readable stablecoin ID -> metadata. */
export const READABLE_META_BY_ID = new Map(
  READABLE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);
