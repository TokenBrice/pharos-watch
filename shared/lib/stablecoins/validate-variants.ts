import type { StablecoinMeta } from "../../types";
import { isActiveStablecoinMeta, isReadableStablecoinMeta } from "./status";

function hasVariantFields(meta: StablecoinMeta): boolean {
  return meta.variantOf != null || meta.variantKind != null;
}

function collectDirectWrapperParentCandidates(meta: StablecoinMeta): string[] {
  const candidates = new Set<string>();

  if (meta.pegReferenceId != null) {
    candidates.add(meta.pegReferenceId);
  }

  for (const dependency of meta.dependencies ?? []) {
    if (dependency.type === "wrapper") {
      candidates.add(dependency.id);
    }
  }

  for (const reserve of meta.reserves ?? []) {
    if (reserve.depType === "wrapper" && reserve.coinId != null) {
      candidates.add(reserve.coinId);
    }
  }

  for (const relationship of meta.dependencyReview?.relationships ?? []) {
    if (relationship.type === "wrapper" && relationship.economicRole === "serial-claim") {
      candidates.add(relationship.id);
    }
  }

  return [...candidates];
}

function hasReviewedSerialWrapperRelationship(meta: StablecoinMeta): boolean {
  return (meta.dependencyReview?.relationships ?? []).some(
    (relationship) => relationship.type === "wrapper" && relationship.economicRole === "serial-claim",
  );
}

function hasOtherTrackedLinkedExposure(
  meta: StablecoinMeta,
  parentId: string,
  metaById: ReadonlyMap<string, StablecoinMeta>,
): boolean {
  for (const dependency of meta.dependencies ?? []) {
    if (dependency.id !== parentId && metaById.has(dependency.id)) {
      return true;
    }
  }

  for (const reserve of meta.reserves ?? []) {
    if (reserve.coinId != null && reserve.coinId !== parentId && metaById.has(reserve.coinId)) {
      return true;
    }
  }

  for (const relationship of meta.dependencyReview?.relationships ?? []) {
    if (relationship.id !== parentId && metaById.has(relationship.id)) {
      return true;
    }
  }

  return false;
}

export function validateVariantRelationships(tracked: StablecoinMeta[]): string[] {
  const errors: string[] = [];
  const metaById = new Map(tracked.map((meta) => [meta.id, meta]));
  const activeIds = new Set(tracked.filter(isActiveStablecoinMeta).map((meta) => meta.id));
  const readableIds = new Set(tracked.filter(isReadableStablecoinMeta).map((meta) => meta.id));

  for (const meta of tracked) {
    if (
      !hasVariantFields(meta) &&
      isActiveStablecoinMeta(meta) &&
      (meta.flags.navToken === true || hasReviewedSerialWrapperRelationship(meta)) &&
      meta.flags.pegCurrency === "USD"
    ) {
      const activeNonNavParents = collectDirectWrapperParentCandidates(meta).filter((id) => {
        const parent = metaById.get(id);
        return parent != null && isActiveStablecoinMeta(parent) && parent.flags.navToken !== true;
      });

      if (activeNonNavParents.length === 1) {
        const parentId = activeNonNavParents[0];
        if (hasOtherTrackedLinkedExposure(meta, parentId, metaById)) {
          continue;
        }

        errors.push(
          `${meta.id}: active USD ${meta.flags.navToken === true ? "navToken" : "asset with a reviewed serial wrapper"} has direct wrapper exposure to ${parentId} but does not declare variantOf / variantKind. ` +
            `Fix: add variantOf "${parentId}" with the appropriate variantKind, or remove the direct wrapper parent signal if this is not a tracked parent-child variant.`,
        );
      }
    }

    if (!hasVariantFields(meta)) continue;

    if (meta.variantOf == null || meta.variantKind == null) {
      errors.push(`${meta.id}: variantOf and variantKind must both be set or both be absent`);
      continue;
    }

    if (!isReadableStablecoinMeta(meta)) {
      errors.push(`${meta.id}: only post-launch readable assets may declare variantOf / variantKind`);
    }

    if (meta.variantOf === meta.id) {
      errors.push(
        `${meta.id}: variantOf must not reference the asset itself (self-cycle). ` +
          `Fix: remove variantOf or point it at the correct parent asset.`,
      );
      continue;
    }

    const parent = metaById.get(meta.variantOf);
    if (!parent) {
      errors.push(
        `${meta.id}: variantOf "${meta.variantOf}" does not match any tracked stablecoin id. ` +
          `Fix: correct the variantOf id or add the parent to the registry.`,
      );
      continue;
    }
    const parentIds = isActiveStablecoinMeta(meta) ? activeIds : readableIds;
    if (!parentIds.has(meta.variantOf)) {
      errors.push(
        `${meta.id}: variantOf must point to ${isActiveStablecoinMeta(meta) ? "an active" : "a readable post-launch"} tracked stablecoin`,
      );
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

    if (meta.variantKind === "pure-wrapper" && meta.flags.navToken === true) {
      errors.push(`${meta.id}: pure-wrapper variants must keep flags.navToken === false`);
    } else if (meta.variantKind !== "pure-wrapper" && meta.flags.navToken !== true) {
      errors.push(`${meta.id}: non-pure tracked variants must keep flags.navToken === true`);
    }

    if (
      meta.mechanismArchetype != null &&
      parent.mechanismArchetype != null &&
      meta.mechanismArchetype !== parent.mechanismArchetype &&
      meta.archetypeOverride !== true
    ) {
      errors.push(
        `${meta.id}: mechanismArchetype "${meta.mechanismArchetype}" differs from parent ${parent.id} archetype "${parent.mechanismArchetype}" without archetypeOverride: true. ` +
          `Fix: either set archetypeOverride: true on ${meta.id} or remove its mechanismArchetype and let the resolver inherit from the parent.`,
      );
    }

    if (
      meta.archetypeOverride === true &&
      meta.mechanismArchetype != null &&
      meta.mechanismArchetype === parent.mechanismArchetype
    ) {
      errors.push(
        `${meta.id}: archetypeOverride is only valid for an intentional departure from parent ${parent.id}. ` +
          `Remove the redundant override and direct mechanismArchetype to inherit the parent classification.`,
      );
    }

    // Null-parent + declared child archetype: the resolver would silently use
    // the child's own archetype, which can mask a missing parent classification.
    // Require archetypeOverride: true so the divergence is explicit.
    if (meta.mechanismArchetype != null && parent.mechanismArchetype == null && meta.archetypeOverride !== true) {
      errors.push(
        `${meta.id}: declares mechanismArchetype "${meta.mechanismArchetype}" but parent ${parent.id} has no archetype. ` +
          `Fix: either classify parent ${parent.id} with a mechanismArchetype, or set archetypeOverride: true on ${meta.id} to declare an intentional departure.`,
      );
    }
  }

  return errors;
}
