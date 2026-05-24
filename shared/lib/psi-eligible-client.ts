import { CLIENT_ACTIVE_META_BY_ID } from "./stablecoins/client-registry";
import { SHADOW_META_BY_ID } from "./shadow-stablecoins";

/** Slim client-side PSI lookup = active tracked + shadow PSI assets. */
export const CLIENT_PSI_ELIGIBLE_META_BY_ID = new Map([
  ...CLIENT_ACTIVE_META_BY_ID,
  ...SHADOW_META_BY_ID,
]);
