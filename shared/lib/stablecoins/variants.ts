import { deriveEffectiveDependencies } from "../dependency-derivation";
import type { DependencyWeight, StablecoinMeta, VariantKind } from "../../types";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "./registry";
import { isActiveStablecoinMeta } from "./status";
import { createVariantRelationshipHelpers } from "./variant-relationships";

function hasTrackedVariantMeta(
  meta: StablecoinMeta | undefined,
): meta is StablecoinMeta & { variantOf: string; variantKind: VariantKind } {
  return meta?.variantOf != null && meta.variantKind != null && isActiveStablecoinMeta(meta);
}

export function deriveVariantAwareDependencies(
  meta: Pick<StablecoinMeta, "variantOf" | "dependencies" | "reserves">,
): DependencyWeight[] {
  return deriveEffectiveDependencies(meta);
}

const variantHelpers = createVariantRelationshipHelpers({
  activeMetaById: ACTIVE_META_BY_ID,
  activeStablecoins: ACTIVE_STABLECOINS,
  hasTrackedVariantMeta,
});

export const getVariantParent = variantHelpers.getVariantParent;
export const getVariants = variantHelpers.getVariants;
export const getVariantRelationship = variantHelpers.getVariantRelationship;
export const isTrackedVariant = variantHelpers.isTrackedVariant;
