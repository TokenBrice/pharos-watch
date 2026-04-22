import type { StablecoinMeta } from "../../types";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import perCoinGeneratedAsset from "../../data/stablecoins/coins.generated.json";
import commodityAsset from "../../data/stablecoins/commodity.json";
import nonUsdAsset from "../../data/stablecoins/non-usd.json";
import preLaunchAsset from "../../data/stablecoins/pre-launch.json";
import usdMajorAsset from "../../data/stablecoins/usd-major.json";
import usdMinorAsset from "../../data/stablecoins/usd-minor.json";
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

export const USD_MAJOR_COINS: StablecoinMeta[] = parseStablecoinMetaAssets(
  usdMajorAsset,
  "shared/data/stablecoins/usd-major.json",
);

export const USD_MINOR_COINS: StablecoinMeta[] = parseStablecoinMetaAssets(
  usdMinorAsset,
  "shared/data/stablecoins/usd-minor.json",
);

export const NON_USD_COINS: StablecoinMeta[] = parseStablecoinMetaAssets(
  nonUsdAsset,
  "shared/data/stablecoins/non-usd.json",
);

export const COMMODITY_COINS: StablecoinMeta[] = parseStablecoinMetaAssets(
  commodityAsset,
  "shared/data/stablecoins/commodity.json",
);

const PRE_LAUNCH_COIN_ENTRIES: StablecoinMeta[] = parseStablecoinMetaAssets(
  preLaunchAsset,
  "shared/data/stablecoins/pre-launch.json",
);

const STABLECOIN_SOURCES = [
  {
    label: "shared/data/stablecoins/usd-major.json",
    coins: USD_MAJOR_COINS,
  },
  {
    label: "shared/data/stablecoins/usd-minor.json",
    coins: USD_MINOR_COINS,
  },
  {
    label: "shared/data/stablecoins/non-usd.json",
    coins: NON_USD_COINS,
  },
  {
    label: "shared/data/stablecoins/commodity.json",
    coins: COMMODITY_COINS,
  },
  {
    label: "shared/data/stablecoins/pre-launch.json",
    coins: PRE_LAUNCH_COIN_ENTRIES,
  },
  {
    label: "shared/data/stablecoins/coins.generated.json",
    coins: PER_COIN_SOURCE_COINS,
  },
] as const;

const allEntries: StablecoinMeta[] = [
  ...USD_MAJOR_COINS,
  ...USD_MINOR_COINS,
  ...NON_USD_COINS,
  ...COMMODITY_COINS,
  ...PRE_LAUNCH_COIN_ENTRIES,
  ...PER_COIN_SOURCE_COINS,
];

const duplicateSourcesById = new Map<string, string[]>();
for (const source of STABLECOIN_SOURCES) {
  for (const stablecoin of source.coins) {
    const sources = duplicateSourcesById.get(stablecoin.id);
    if (sources) {
      sources.push(source.label);
    } else {
      duplicateSourcesById.set(stablecoin.id, [source.label]);
    }
  }
}

const duplicateIdIssues = [...duplicateSourcesById.entries()]
  .filter(([, labels]) => labels.length > 1)
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([id, labels]) => `${id}: ${labels.join(", ")}`);

if (duplicateIdIssues.length > 0) {
  throw new Error(`Stablecoin source duplication failed:\n${duplicateIdIssues.join("\n")}`);
}

const byId = new Map(allEntries.map((stablecoin) => [stablecoin.id, stablecoin]));
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

const missingCanonicalOrderIds = allEntries
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

/** Stablecoins with full worker processing (excludes pre-launch). */
export const ACTIVE_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.status !== "pre-launch",
);

/** Set of active stablecoin IDs (excludes pre-launch). */
export const ACTIVE_IDS = new Set(ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of active stablecoin ID -> metadata (excludes pre-launch). */
export const ACTIVE_META_BY_ID = new Map(ACTIVE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]));

/** Stablecoins in pre-launch stage. */
export const PRE_LAUNCH_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.status === "pre-launch",
);
