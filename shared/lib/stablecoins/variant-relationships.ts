import type { VariantKind } from "../../types";

export interface VariantCapableMeta {
  id: string;
  variantOf?: string | null;
  variantKind?: VariantKind | null;
}

export interface VariantRelationship<TMeta extends VariantCapableMeta> {
  parent: TMeta;
  kind: VariantKind;
  siblings: TMeta[];
}

interface VariantRelationshipHelperInput<TMeta extends VariantCapableMeta> {
  activeMetaById: ReadonlyMap<string, TMeta>;
  activeStablecoins: readonly TMeta[];
  hasTrackedVariantMeta: (
    meta: TMeta | undefined,
  ) => meta is TMeta & { variantOf: string; variantKind: VariantKind };
}

export function createVariantRelationshipHelpers<TMeta extends VariantCapableMeta>({
  activeMetaById,
  activeStablecoins,
  hasTrackedVariantMeta,
}: VariantRelationshipHelperInput<TMeta>) {
  function getVariantParent(id: string): TMeta | null {
    const meta = activeMetaById.get(id);
    if (!hasTrackedVariantMeta(meta)) return null;
    return activeMetaById.get(meta.variantOf) ?? null;
  }

  function getVariants(parentId: string): TMeta[] {
    return activeStablecoins.filter((meta) => meta.variantOf === parentId);
  }

  function getVariantRelationship(id: string): VariantRelationship<TMeta> | null {
    const meta = activeMetaById.get(id);
    if (!hasTrackedVariantMeta(meta)) return null;

    const parent = activeMetaById.get(meta.variantOf);
    if (!parent) return null;

    return {
      parent,
      kind: meta.variantKind,
      siblings: getVariants(parent.id).filter((variant) => variant.id !== id),
    };
  }

  function isTrackedVariant(id: string): boolean {
    return hasTrackedVariantMeta(activeMetaById.get(id));
  }

  return {
    getVariantParent,
    getVariants,
    getVariantRelationship,
    isTrackedVariant,
  };
}
