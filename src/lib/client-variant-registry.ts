import {
  CLIENT_ACTIVE_META_BY_ID,
  CLIENT_ACTIVE_STABLECOINS,
  type StablecoinClientMeta,
} from "@shared/lib/stablecoins/client-registry";
import { createVariantRelationshipHelpers } from "@shared/lib/stablecoins/variant-relationships";
import type { VariantKind } from "@shared/types";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";

function hasTrackedVariantMeta(
  meta: StablecoinClientMeta | undefined,
): meta is StablecoinClientMeta & { variantOf: string; variantKind: VariantKind } {
  return meta?.variantOf != null && meta.variantKind != null && isActiveStablecoinMeta(meta);
}

const clientVariantHelpers = createVariantRelationshipHelpers({
  activeMetaById: CLIENT_ACTIVE_META_BY_ID,
  activeStablecoins: CLIENT_ACTIVE_STABLECOINS,
  hasTrackedVariantMeta,
});

export const getClientVariantParent = clientVariantHelpers.getVariantParent;
export const getClientVariants = clientVariantHelpers.getVariants;
export const getClientVariantRelationship = clientVariantHelpers.getVariantRelationship;
