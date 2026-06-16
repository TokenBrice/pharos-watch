import { deriveEffectiveDependencies } from "../dependency-derivation";
import type { StablecoinMeta, VariantKind } from "../../types";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "./registry";
import { isActiveStablecoinMeta } from "./status";
import { createVariantRelationshipHelpers } from "./variant-relationships";

function hasTrackedVariantMeta(
  meta: StablecoinMeta | undefined,
): meta is StablecoinMeta & { variantOf: string; variantKind: VariantKind } {
  return meta?.variantOf != null && meta.variantKind != null && isActiveStablecoinMeta(meta);
}

export { deriveEffectiveDependencies as deriveVariantAwareDependencies };

/**
 * These exported helpers are bound to the LIVE full registry singletons
 * (`ACTIVE_META_BY_ID` / `ACTIVE_STABLECOINS`). Importing any of them therefore
 * transitively loads the entire ~1.37 MiB coin catalog via `./registry`.
 *
 * Isolated unit tests should NOT import these — import the generic factory
 * `createVariantRelationshipHelpers` from `./variant-relationships` directly
 * with fixture data instead (see variant-relationships for the injectable
 * shape). The coupling here is intentional: production callers want the live
 * catalog and the static registry import already pays the JSON cost, so a lazy
 * wrapper would not defer the load.
 */
const variantHelpers = createVariantRelationshipHelpers({
  activeMetaById: ACTIVE_META_BY_ID,
  activeStablecoins: ACTIVE_STABLECOINS,
  hasTrackedVariantMeta,
});

export const getVariantParent = variantHelpers.getVariantParent;
export const getVariants = variantHelpers.getVariants;
export const getVariantRelationship = variantHelpers.getVariantRelationship;
export const isTrackedVariant = variantHelpers.isTrackedVariant;
