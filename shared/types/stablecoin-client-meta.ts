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

export interface MintAuthorityCoverageControlSummary {
  authorityType: MintAuthorityType;
  directMintAbility: MintAuthorityDirectMintAbility;
}

export interface MintAuthorityCoverageSummary {
  mintPath: MintAuthorityMintPath;
  authorityPosture: MintAuthorityPosture;
  controls?: MintAuthorityCoverageControlSummary[];
}

type BlacklistClientStatus = NonNullable<StablecoinMeta["blacklistabilityReview"]>["reviewedStatus"];
type GeniusSourceProfile = NonNullable<StablecoinMeta["genius"]>;

export type GeniusClientProfile = Pick<
  GeniusSourceProfile,
  | "applicability"
  | "authorizationStatus"
  | "issuerPathway"
  | "issuerEntity"
  | "issuerDomicile"
  | "licensingRegulator"
  | "primaryFederalRegulator"
  | "stateRegulator"
  | "reserveDisclosurePresent"
  | "reserveDisclosureUrl"
  | "redemptionPolicyPresent"
  | "latestReportDate"
  | "references"
  | "reviewer"
  | "reviewedAt"
>;

/**
 * Slim projection of `StablecoinMeta` for client-side consumers.
 *
 * The full server-side `StablecoinMeta` carries ~50 fields including heavy
 * arrays (`contracts`, `dependencies`, `blacklistabilityReview`,
 * `featuredContent`, `obituary` text, etc.). Shipping all of that to the
 * browser costs ~1.37 MiB of JSON. This client type keeps only the fields
 * client surfaces actually read for routing, labels, filtering, basic
 * classification, reserve coverage summaries, mint-authority coverage
 * classification, compliance-table display, and portfolio exposure. Stablecoin
 * detail pages add page-specific full mint-authority summaries outside this
 * global registry so coverage growth does not inflate every route's client
 * chunk. GENIUS compliance evidence is also projected to displayed fields only;
 * notes, reviewer metadata, source kinds, and full negative-evidence reviews
 * remain in the source JSON/server registry.
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
  | "commodityOunces"
  | "infrastructures"
  | "mica"
  | "yieldConfig"
  | "reserves"
  | "collateralQuality"
> & {
  blacklistStatus?: BlacklistClientStatus;
  genius?: GeniusClientProfile;
  mintAuthoritySummary?: MintAuthorityCoverageSummary;
  /**
   * Adapter key derived from the server-only `liveReservesConfig`. Cross-coin
   * client surfaces (`/coverage`) resolve the reserve display badge from this
   * key without shipping the full live reserve config (~128 KB) to the client.
   */
  liveReserveAdapter?: NonNullable<StablecoinMeta["liveReservesConfig"]>["adapter"];
};

/** Canonical ordered list of source fields copied into the client projection. */
export const STABLECOIN_CLIENT_META_FIELDS = [
  "id",
  "name",
  "symbol",
  "oneLiner",
  "flags",
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
  "commodityOunces",
  "infrastructures",
  "mica",
  "genius",
  "yieldConfig",
  "reserves",
  "collateralQuality",
] as const satisfies ReadonlyArray<keyof StablecoinClientMeta>;
