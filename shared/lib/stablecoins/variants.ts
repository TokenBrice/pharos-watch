import { deriveEffectiveDependencies } from "../dependency-derivation";
import type { DependencyWeight, StablecoinMeta, VariantKind } from "../../types";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "./registry";

function hasTrackedVariantMeta(
  meta: StablecoinMeta | undefined,
): meta is StablecoinMeta & { variantOf: string; variantKind: VariantKind } {
  return meta?.variantOf != null && meta.variantKind != null && meta.status !== "pre-launch";
}

export function deriveVariantAwareDependencies(
  meta: Pick<StablecoinMeta, "variantOf" | "dependencies" | "reserves">,
): DependencyWeight[] {
  return deriveEffectiveDependencies(meta);
}

export function getVariantParent(id: string): StablecoinMeta | null {
  const meta = ACTIVE_META_BY_ID.get(id);
  if (!hasTrackedVariantMeta(meta)) return null;
  return ACTIVE_META_BY_ID.get(meta.variantOf) ?? null;
}

export function getVariants(parentId: string): StablecoinMeta[] {
  return ACTIVE_STABLECOINS.filter((meta) => meta.variantOf === parentId);
}

export function getVariantRelationship(id: string): {
  parent: StablecoinMeta;
  kind: VariantKind;
  siblings: StablecoinMeta[];
} | null {
  const meta = ACTIVE_META_BY_ID.get(id);
  if (!hasTrackedVariantMeta(meta)) return null;

  const parent = ACTIVE_META_BY_ID.get(meta.variantOf);
  if (!parent) return null;

  return {
    parent,
    kind: meta.variantKind,
    siblings: getVariants(parent.id).filter((variant) => variant.id !== id),
  };
}

export function isTrackedVariant(id: string): boolean {
  return hasTrackedVariantMeta(ACTIVE_META_BY_ID.get(id));
}
