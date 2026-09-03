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

export type { MintAuthorityConfidence, MintAuthorityMintPath, MintAuthorityPosture } from "./core";

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

/** Canonical source fields in the cross-coin list projection. */
export const STABLECOIN_CLIENT_LIST_FIELDS = [
  "id",
  "name",
  "symbol",
  "protocolSlug",
  "flags",
  "mechanismArchetype",
  "variantOf",
  "variantKind",
  "expectedLaunchDate",
  "commodityOunces",
  "status",
  "frozenAt",
  "launchDate",
  "launchPhase",
] as const satisfies ReadonlyArray<keyof StablecoinMeta>;

/** Canonical source fields in each on-demand detail projection. */
export const STABLECOIN_CLIENT_DETAIL_FIELDS = [
  "oneLiner",
  "marketAvailability",
  "implementationLaunchDate",
  "geckoId",
  "protocolSlug",
  "listingStatusReview",
  "tags",
  "milestones",
  "dateHistory",
  "infrastructures",
  "mica",
  "genius",
  "yieldConfig",
  "reserves",
  "collateralQuality",
  "custodyModel",
  "mechanismArchetypeReview",
  "variantOf",
  "variantKind",
  "archetypeOverride",
] as const satisfies ReadonlyArray<keyof StablecoinMeta>;

/** Backwards-compatible name for the canonical list field contract. */
export const STABLECOIN_CLIENT_META_FIELDS = STABLECOIN_CLIENT_LIST_FIELDS;

type StablecoinClientSourceField = Exclude<(typeof STABLECOIN_CLIENT_DETAIL_FIELDS)[number], "genius">;

export type ClientMintAuthorityStatus =
  | "no-privileged-mint"
  | "governed-mint"
  | "multisig-mint"
  | "issuer-or-backend-mint"
  | "bridge-mint"
  | "inherited-authority"
  | "unknown";

export type StablecoinClientListMeta = Pick<StablecoinMeta, (typeof STABLECOIN_CLIENT_LIST_FIELDS)[number]> & {
  /** Chain IDs are derived from contracts and tradedContracts at build time. */
  chainIds?: string[];
  listingClass: ListingClass;
  /** Compact cross-coin badges; detail evidence remains on the loaded projection. */
  custodyModel?: StablecoinMeta["custodyModel"];
  blacklistStatus?: BlacklistClientStatus;
  mintAuthorityStatus?: ClientMintAuthorityStatus;
  mintAuthoritySummary?: MintAuthorityCoverageSummary;
  liveReserveAdapter?: NonNullable<StablecoinMeta["liveReservesConfig"]>["adapter"];
  /** Compact yield taxonomy badge; source-specific yield configuration stays in detail. */
  yieldType?: NonNullable<StablecoinMeta["yieldConfig"]>["yieldType"];
};

export type StablecoinClientDetailMeta = StablecoinClientListMeta &
  Pick<StablecoinMeta, StablecoinClientSourceField> & {
    genius?: GeniusComplianceProfile;
    blacklistStatus?: BlacklistClientStatus;
    mintAuthoritySummary?: MintAuthorityCoverageSummary;
    liveReserveAdapter?: NonNullable<StablecoinMeta["liveReservesConfig"]>["adapter"];
  };

/**
 * Client-side metadata contract. The eagerly loaded shape is the compact list;
 * detail fields are optional because they arrive through loadClientStablecoinDetail.
 */
export type StablecoinClientMeta = StablecoinClientDetailMeta;
