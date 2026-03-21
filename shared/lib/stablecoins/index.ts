import type { StablecoinMeta } from "../../types";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import commodityAsset from "../../data/stablecoins/commodity.json";
import nonUsdAsset from "../../data/stablecoins/non-usd.json";
import usdMajorAsset from "../../data/stablecoins/usd-major.json";
import usdMinorAsset from "../../data/stablecoins/usd-minor.json";
import {
  parseCanonicalOrderAsset,
  parseStablecoinMetaAssets,
} from "./schema";

const CANONICAL_ORDER = parseCanonicalOrderAsset(
  canonicalOrderAsset,
  "shared/data/stablecoins/canonical-order.json",
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

const allEntries: StablecoinMeta[] = [
  ...USD_MAJOR_COINS,
  ...USD_MINOR_COINS,
  ...NON_USD_COINS,
  ...COMMODITY_COINS,
];

const byId = new Map(allEntries.map((stablecoin) => [stablecoin.id, stablecoin]));

/** Tracked stablecoins in canonical market-cap order. */
export const TRACKED_STABLECOINS: StablecoinMeta[] = CANONICAL_ORDER.map((id) => {
  const entry = byId.get(id);
  if (!entry) {
    throw new Error(`canonical-order.json references unknown stablecoin ID: ${id}`);
  }
  return entry;
});

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
