import type { StablecoinMeta } from "../../types";

function hasVariantFields(meta: StablecoinMeta): boolean {
  return meta.variantOf != null || meta.variantKind != null;
}

export function validateVariantRelationships(tracked: StablecoinMeta[]): string[] {
  const errors: string[] = [];
  const metaById = new Map(tracked.map((meta) => [meta.id, meta]));
  const activeIds = new Set(
    tracked
      .filter((meta) => meta.status !== "pre-launch")
      .map((meta) => meta.id),
  );

  for (const meta of tracked) {
    if (!hasVariantFields(meta)) continue;

    if (meta.variantOf == null || meta.variantKind == null) {
      errors.push(`${meta.id}: variantOf and variantKind must both be set or both be absent`);
      continue;
    }

    if (meta.status === "pre-launch") {
      errors.push(`${meta.id}: only active assets may declare variantOf / variantKind`);
    }

    if (meta.variantOf === meta.id) {
      errors.push(`${meta.id}: variantOf must not reference the asset itself`);
    }

    const parent = metaById.get(meta.variantOf);
    if (!parent || !activeIds.has(meta.variantOf)) {
      errors.push(`${meta.id}: variantOf must point to an active tracked stablecoin`);
      continue;
    }

    if (parent.variantOf != null) {
      errors.push(`${meta.id}: variant parent ${parent.id} must not itself declare variantOf`);
    }

    if (parent.flags.navToken) {
      errors.push(`${meta.id}: variant parent ${parent.id} must not be a navToken`);
    }

    if (meta.pegReferenceId !== meta.variantOf) {
      errors.push(`${meta.id}: pegReferenceId must equal variantOf`);
    }

    if (meta.flags.navToken !== true) {
      errors.push(`${meta.id}: tracked variants must keep flags.navToken === true`);
    }
  }

  return errors;
}
