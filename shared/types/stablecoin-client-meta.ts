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
  "commodityOunces",
  "infrastructures",
  "mica",
  "genius",
  "yieldConfig",
  "reserves",
  "collateralQuality",
  "custodyModel",
] as const satisfies ReadonlyArray<keyof StablecoinMeta>;

type StablecoinClientSourceField = Exclude<(typeof STABLECOIN_CLIENT_META_FIELDS)[number], "genius">;

/**
 * Slim projection of `StablecoinMeta` for client-side consumers. The runtime
 * projection tuple above is authoritative; this type is derived from it so a
 * generator field cannot drift from the promised client contract.
 */
export type StablecoinClientMeta = Pick<StablecoinMeta, StablecoinClientSourceField> & {
  /** Compact decision-ledger projection used by client aggregate filters. */
  listingClass: ListingClass;
  blacklistStatus?: BlacklistClientStatus;
  genius?: GeniusClientProfile;
  mintAuthoritySummary?: MintAuthorityCoverageSummary;
  /** Adapter key derived from the server-only `liveReservesConfig`. */
  liveReserveAdapter?: NonNullable<StablecoinMeta["liveReservesConfig"]>["adapter"];
};
