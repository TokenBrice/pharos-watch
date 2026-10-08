import {
  CORE_AGGREGATE_ACTIVE_IDS,
  CORE_AGGREGATE_ACTIVE_META_BY_ID,
  CORE_AGGREGATE_ACTIVE_STABLECOINS,
} from "./stablecoins/aggregate-registry";
import { ACTIVE_IDS, ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "./stablecoins/registry";
import { PSI_HISTORICAL_ASSETS, PSI_HISTORICAL_IDS, PSI_HISTORICAL_META_BY_ID } from "./psi-historical-assets";
import type { StablecoinMeta } from "../types";

/** Broad monitoring universe used by depeg, DEWS, and per-asset history lanes. */
export const PSI_ELIGIBLE_IDS: ReadonlySet<string> = new Set([...ACTIVE_IDS, ...PSI_HISTORICAL_IDS]);
export const PSI_ELIGIBLE_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = new Map([
  ...ACTIVE_META_BY_ID,
  ...PSI_HISTORICAL_META_BY_ID,
]);
export const PSI_ELIGIBLE_STABLECOINS: readonly StablecoinMeta[] = [...ACTIVE_STABLECOINS, ...PSI_HISTORICAL_ASSETS];

/** Monetary aggregate used only by PSI computation and replay. */
export const CORE_PSI_ELIGIBLE_IDS: ReadonlySet<string> = new Set([...CORE_AGGREGATE_ACTIVE_IDS, ...PSI_HISTORICAL_IDS]);
export const CORE_PSI_ELIGIBLE_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = new Map([
  ...CORE_AGGREGATE_ACTIVE_META_BY_ID,
  ...PSI_HISTORICAL_META_BY_ID,
]);
export const CORE_PSI_ELIGIBLE_STABLECOINS: readonly StablecoinMeta[] = [
  ...CORE_AGGREGATE_ACTIVE_STABLECOINS,
  ...PSI_HISTORICAL_ASSETS,
];
