import type { StablecoinMeta } from "@shared/types";
import { type ExtensionAsset, type V9ExtensionRegistryMeta } from "./extension-shared";

type PegReferenceRegistryMeta = V9ExtensionRegistryMeta & Pick<StablecoinMeta, "pegReferenceId">;

const PEG_REFERENCE_ID_MARKER = ":peg-reference:";

const PEG_REFERENCE_UNRESOLVED_PREFIX = "unresolved:peg-reference:";

function unresolvedPegReference(
  reason: "self-reference" | "unresolvable" | "cycle",
): NonNullable<ExtensionAsset["pegReference"]> {
  return {
    referenceKind: "other",
    referenceKey: `${PEG_REFERENCE_UNRESOLVED_PREFIX}${reason}`,
    failureDomains: [],
  };
}

function pegReferenceId(meta: V9ExtensionRegistryMeta): string | undefined {
  return (meta as PegReferenceRegistryMeta).pegReferenceId;
}

function buildOwnPegReference(meta: V9ExtensionRegistryMeta): ExtensionAsset["pegReference"] {
  // Pure NAV tokens track fund NAV by design: they have no fixed peg to
  // deviate from, so the peg fact is published not-applicable (the v8 pure
  // NAV carve-over) instead of failing on a missing peg reference.
  if (meta.flags?.navToken === true) {
    return { referenceKind: "nav", referenceKey: `nav:${meta.id}`, failureDomains: [] };
  }
  const pegCurrency = meta.flags?.pegCurrency;
  if (pegCurrency === undefined) return null;
  if (pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return { referenceKind: "other", referenceKey: `unreviewed:${pegCurrency.toLowerCase()}`, failureDomains: [] };
  }
  if (pegCurrency === "GOLD" || pegCurrency === "SILVER") {
    return {
      referenceKind: "asset",
      referenceKey: pegCurrency === "GOLD" ? "commodity:xau" : "commodity:xag",
      failureDomains: [],
    };
  }
  return { referenceKind: "fiat", referenceKey: pegCurrency, failureDomains: [] };
}

export function buildPegReference(
  meta: V9ExtensionRegistryMeta,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
): ExtensionAsset["pegReference"] {
  const ownReference = buildOwnPegReference(meta);
  const configuredReferenceId = pegReferenceId(meta);
  if (configuredReferenceId === undefined) return ownReference;
  if (meta.variantOf != null && meta.variantOf !== configuredReferenceId) {
    throw new Error(
      `Safety Score v9 peg reference data error for ${meta.id}: variantOf (${meta.variantOf}) must equal ` +
        `pegReferenceId (${configuredReferenceId}) when both are present`,
    );
  }
  if (configuredReferenceId === meta.id) return unresolvedPegReference("self-reference");
  const parent = metaById.get(configuredReferenceId);
  if (!parent || parent.id !== configuredReferenceId || ownReference === null) {
    return unresolvedPegReference("unresolvable");
  }
  if (pegReferenceId(parent) === meta.id) return unresolvedPegReference("cycle");
  return {
    ...ownReference,
    referenceKey: `${ownReference.referenceKey}${PEG_REFERENCE_ID_MARKER}${configuredReferenceId}`,
  };
}
