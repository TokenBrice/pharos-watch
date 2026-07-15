import type {
  MintAuthorityConfidence,
  MintAuthorityControl,
  MintAuthorityMintPath,
  MintAuthorityPosture,
  MintAuthorityProfile,
  StablecoinLink,
  StablecoinMeta,
} from "./core";
import type { ListingClass } from "./stablecoin-taxonomy";

export type {
  MintAuthorityConfidence,
  MintAuthorityControlRole,
  MintAuthorityDirectMintAbility,
  MintAuthorityMintPath,
  MintAuthorityPosture,
  MintAuthorityType,
} from "./core";

export type MintAuthorityClientControlSummary = Pick<
  MintAuthorityControl,
  | "chain"
  | "address"
  | "label"
  | "role"
  | "authorityType"
  | "directMintAbility"
  | "threshold"
  | "signerCount"
  | "timelockDelaySec"
  | "capDescription"
  | "canRaiseCap"
  | "modulesOrGuardsStatus"
  | "keyCustodyAttestation"
>;

export interface MintAuthorityClientSummary {
  mintPath: MintAuthorityMintPath;
  authorityPosture: MintAuthorityPosture;
  confidence: MintAuthorityConfidence;
  summary: string;
  inheritedFrom?: string;
  mintIncidents?: MintAuthorityProfile["mintIncidents"];
  controls?: MintAuthorityClientControlSummary[];
  sources?: StablecoinLink[];
  reviewedAt?: string;
  sourceFreeRationale?: string;
  unresolvedQuestions?: string[];
}

/** Present only on the detail-page projection; the generated cross-coin payload omits labels. */
export type MintAuthorityCoverageControlSummary = Omit<
  MintAuthorityClientControlSummary,
  "chain" | "address" | "role" | "capDescription" | "label"
> & { label?: string };

export type MintAuthorityCoverageSummary = Pick<
  MintAuthorityClientSummary,
  "mintPath" | "authorityPosture" | "confidence" | "inheritedFrom" | "mintIncidents"
> & {
  controls?: MintAuthorityCoverageControlSummary[];
};

type BlacklistClientStatus = NonNullable<StablecoinMeta["blacklistabilityReview"]>["reviewedStatus"];
type GeniusSourceProfile = NonNullable<StablecoinMeta["genius"]>;

export const GENIUS_CLIENT_PROFILE_FIELDS = ["authorizationStatus"] as const satisfies ReadonlyArray<
  keyof GeniusSourceProfile
>;

export const GENIUS_COMPLIANCE_PROFILE_FIELDS = [
  "applicability",
  "applicabilityBasis",
  "authorizationStatus",
  "issuerPathway",
  "issuerEntity",
  "issuerDomicile",
  "licensingRegulator",
  "primaryFederalRegulator",
  "stateRegulator",
  "foreignExceptionStatus",
  "foreignExceptionEvidence",
  "enforcementStatus",
  "daspOfferSaleStatus",
  "reserveDisclosurePresent",
  "reserveDisclosureUrl",
  "redemptionPolicyPresent",
  "monthlyAttestationPresent",
  "latestReportDate",
  "notes",
  "references",
  "negativeEvidenceReview",
  "reviewer",
  "reviewedAt",
] as const satisfies ReadonlyArray<keyof GeniusSourceProfile>;

export type GeniusClientProfile = Pick<GeniusSourceProfile, (typeof GENIUS_CLIENT_PROFILE_FIELDS)[number]>;

export type GeniusComplianceProfile = Pick<GeniusSourceProfile, (typeof GENIUS_COMPLIANCE_PROFILE_FIELDS)[number]>;

/**
 * Slim projection of `StablecoinMeta` for client-side consumers.
 *
 * The full server-side `StablecoinMeta` carries ~50 fields including heavy
 * arrays (`contracts`, `dependencies`, `blacklistabilityReview`,
 * `featuredContent`, `obituary` text, etc.). This client type keeps only the fields
 * client surfaces actually read for routing, labels, filtering, basic
 * classification, reserve coverage summaries, mint-authority coverage
 * classification, compliance status labels, and portfolio exposure. Stablecoin
 * detail pages add page-specific full mint-authority summaries outside this
 * global registry so coverage growth does not inflate every route's client
 * chunk. GENIUS long-form compliance evidence is projected into a
 * compliance-route asset outside this global registry; source JSON remains the
 * canonical editorial record.
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
  | "marketAvailability"
  | "flags"
  | "mechanismArchetype"
  | "mechanismArchetypeReview"
  | "implementationLaunchDate"
  | "archetypeOverride"
  | "geckoId"
  | "protocolSlug"
  | "variantOf"
  | "variantKind"
  | "status"
  | "listingStatusReview"
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
  /** Compact decision-ledger projection used by client aggregate filters. */
  listingClass: ListingClass;
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
  "marketAvailability",
  "flags",
  "mechanismArchetype",
  "mechanismArchetypeReview",
  "implementationLaunchDate",
  "archetypeOverride",
  "geckoId",
  "protocolSlug",
  "variantOf",
  "variantKind",
  "status",
  "listingStatusReview",
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
