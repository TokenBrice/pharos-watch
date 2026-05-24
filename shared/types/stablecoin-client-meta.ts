import type {
  MintAuthorityConfidence,
  MintAuthorityControl,
  MintAuthorityControlRole,
  MintAuthorityDirectMintAbility,
  MintAuthorityMintPath,
  MintAuthorityPosture,
  MintAuthorityType,
  StablecoinLink,
  StablecoinMeta,
} from "./core";

export type {
  MintAuthorityConfidence,
  MintAuthorityControlRole,
  MintAuthorityDirectMintAbility,
  MintAuthorityMintPath,
  MintAuthorityPosture,
  MintAuthorityType,
} from "./core";

export interface MintAuthorityClientControlSummary {
  chain?: string;
  address?: string;
  label: string;
  role: MintAuthorityControlRole;
  authorityType: MintAuthorityType;
  directMintAbility: MintAuthorityDirectMintAbility;
  threshold?: number;
  signerCount?: number;
  timelockDelaySec?: number;
  capDescription?: string;
  modulesOrGuardsStatus?: MintAuthorityControl["modulesOrGuardsStatus"];
}

export interface MintAuthorityClientSummary {
  mintPath: MintAuthorityMintPath;
  authorityPosture: MintAuthorityPosture;
  confidence: MintAuthorityConfidence;
  summary: string;
  inheritedFrom?: string;
  controls?: MintAuthorityClientControlSummary[];
  sources?: StablecoinLink[];
}

/**
 * Slim projection of `StablecoinMeta` for client-side consumers.
 *
 * The full server-side `StablecoinMeta` carries ~50 fields including heavy
 * arrays (`contracts`, `dependencies`, `blacklistabilityReview`,
 * `featuredContent`, `obituary` text, etc.). Shipping all of that to the
 * browser costs ~1.37 MiB of JSON. This client type keeps only the fields
 * client surfaces actually read for routing, labels, filtering, basic
 * classification, reserve coverage summaries, mint-authority summaries, and
 * portfolio exposure.
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
  | "archetypeOverride"
  | "geckoId"
  | "protocolSlug"
  | "variantOf"
  | "variantKind"
  | "status"
  | "tags"
  | "frozenAt"
  | "launchDate"
  | "announcedDate"
  | "expectedLaunchDate"
  | "launchPhase"
  | "milestones"
  | "dateHistory"
  | "canBeBlacklisted"
  | "canBeBlacklistedSource"
  | "commodityOunces"
  | "infrastructures"
  | "mica"
  | "yieldConfig"
  | "liveReservesConfig"
  | "proofOfReserves"
  | "reserves"
  | "collateral"
  | "collateralQuality"
> & {
  mintAuthoritySummary?: MintAuthorityClientSummary;
};

/** Canonical ordered list of source fields copied into the client projection. */
export const STABLECOIN_CLIENT_META_FIELDS = [
  "id",
  "name",
  "symbol",
  "oneLiner",
  "flags",
  "pegMechanism",
  "mechanismArchetype",
  "archetypeOverride",
  "geckoId",
  "protocolSlug",
  "variantOf",
  "variantKind",
  "status",
  "tags",
  "frozenAt",
  "launchDate",
  "announcedDate",
  "expectedLaunchDate",
  "launchPhase",
  "milestones",
  "dateHistory",
  "canBeBlacklisted",
  "canBeBlacklistedSource",
  "commodityOunces",
  "infrastructures",
  "mica",
  "yieldConfig",
  "liveReservesConfig",
  "proofOfReserves",
  "reserves",
  "collateral",
  "collateralQuality",
] as const satisfies ReadonlyArray<keyof StablecoinClientMeta>;
