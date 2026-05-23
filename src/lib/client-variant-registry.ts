import {
  CLIENT_ACTIVE_META_BY_ID,
  CLIENT_ACTIVE_STABLECOINS,
  type StablecoinClientMeta,
} from "@shared/lib/stablecoins/client-registry";
import type { VariantKind } from "@shared/types";

function hasTrackedVariantMeta(
  meta: StablecoinClientMeta | undefined,
): meta is StablecoinClientMeta & { variantOf: string; variantKind: VariantKind } {
  return meta?.variantOf != null && meta.variantKind != null && meta.status !== "pre-launch" && meta.status !== "frozen";
}

export function getClientVariantParent(id: string): StablecoinClientMeta | null {
  const meta = CLIENT_ACTIVE_META_BY_ID.get(id);
  if (!hasTrackedVariantMeta(meta)) return null;
  return CLIENT_ACTIVE_META_BY_ID.get(meta.variantOf) ?? null;
}

export function getClientVariants(parentId: string): StablecoinClientMeta[] {
  return CLIENT_ACTIVE_STABLECOINS.filter((meta) => meta.variantOf === parentId);
}

export function getClientVariantRelationship(id: string): {
  parent: StablecoinClientMeta;
  kind: VariantKind;
  siblings: StablecoinClientMeta[];
} | null {
  const meta = CLIENT_ACTIVE_META_BY_ID.get(id);
  if (!hasTrackedVariantMeta(meta)) return null;

  const parent = CLIENT_ACTIVE_META_BY_ID.get(meta.variantOf);
  if (!parent) return null;

  return {
    parent,
    kind: meta.variantKind,
    siblings: getClientVariants(parent.id).filter((variant) => variant.id !== id),
  };
}
