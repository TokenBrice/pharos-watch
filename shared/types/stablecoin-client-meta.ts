import type { StablecoinMeta } from "./core";

/**
 * Slim projection of `StablecoinMeta` for client-side consumers.
 *
 * The full server-side `StablecoinMeta` carries ~50 fields including heavy
 * arrays (`reserves`, `contracts`, `dependencies`, `blacklistabilityReview`,
 * `featuredContent`, `obituary` text, etc.). Shipping all of that to the
 * browser costs ~1.37 MiB of JSON. This slim type keeps only the fields
 * client surfaces actually read for routing, labels, filtering, and basic
 * classification.
 *
 * Build pipeline: `scripts/build-data/build-client-registry.mjs` projects
 * `coins.generated.json` to a slim JSON consumed by
 * `shared/lib/stablecoins/client-registry.ts`. Any consumer that needs a
 * field NOT in this Pick must import from `@shared/lib/stablecoins/registry`
 * (the fat path) instead.
 */
export type StablecoinClientMeta = Pick<
  StablecoinMeta,
  | "id"
  | "name"
  | "symbol"
  | "oneLiner"
  | "flags"
  | "pegMechanism"
  | "mechanismArchetype"
  | "geckoId"
  | "protocolSlug"
  | "variantOf"
  | "variantKind"
  | "status"
  | "tags"
  | "frozenAt"
  | "launchDate"
  | "launchPhase"
>;

/** Canonical ordered list of fields surfaced in the client projection. */
export const STABLECOIN_CLIENT_META_FIELDS = [
  "id",
  "name",
  "symbol",
  "oneLiner",
  "flags",
  "pegMechanism",
  "mechanismArchetype",
  "geckoId",
  "protocolSlug",
  "variantOf",
  "variantKind",
  "status",
  "tags",
  "frozenAt",
  "launchDate",
  "launchPhase",
] as const satisfies ReadonlyArray<keyof StablecoinClientMeta>;
