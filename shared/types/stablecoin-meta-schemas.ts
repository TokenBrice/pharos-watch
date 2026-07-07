import { z } from "zod";
import type {
  BlacklistabilityReview,
  BridgeRouteProtocolEvidence,
  BridgeRouteRiskProfile,
  CoinNotice,
  ContractDeployment,
  DateHistoryEntry,
  DependencyWeight,
  FeaturedContent,
  GeniusApplicabilityBasis,
  GeniusForeignExceptionEvidence,
  GeniusNegativeEvidenceReview,
  GeniusProfile,
  GeniusReference,
  Jurisdiction,
  LaunchMilestone,
  MicaProfile,
  MintAuthorityControl,
  MintAuthorityDirectMintAbility,
  MintAuthorityProfile,
  MintAuthorityReview,
  MintAuthorityRouteChecks,
  OracleRiskBranch,
  OracleRiskProfile,
  MintAuthoritySafeState,
  ProofOfReserves,
  StablecoinFlags,
  StablecoinLink,
  YieldConfig,
} from "./core";
import {
  ATTESTOR_TIER_VALUES,
  BACKING_TYPE_VALUES,
  BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES,
  BRIDGE_ROUTE_RISK_SOURCE_VALUES,
  BRIDGE_ROUTE_RISK_TIER_VALUES,
  COIN_NOTICE_TYPE_VALUES,
  DEPENDENCY_TYPE_VALUES,
  FEATURED_CONTENT_TYPE_VALUES,
  GENIUS_APPLICABILITY_VALUES,
  GENIUS_AUTHORIZATION_STATUS_VALUES,
  GENIUS_DASP_OFFER_SALE_STATUS_VALUES,
  GENIUS_ENFORCEMENT_STATUS_VALUES,
  GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES,
  GENIUS_ISSUER_PATHWAY_VALUES,
  GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES,
  GENIUS_SOURCE_KIND_VALUES,
  GOVERNANCE_TYPE_VALUES,
  INFRASTRUCTURE_VALUES,
  LAUNCH_MILESTONE_TYPE_VALUES,
  LAUNCH_PHASE_VALUES,
  MARKET_AVAILABILITY_VALUES,
  MECHANISM_ARCHETYPE_VALUES,
  MINT_AUTHORITY_CONFIDENCE_VALUES,
  MINT_AUTHORITY_CONTROL_ROLE_VALUES,
  MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES,
  MINT_AUTHORITY_KEY_CUSTODY_ATTESTATION_KIND_VALUES,
  MINT_AUTHORITY_MINT_PATH_VALUES,
  MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES,
  MINT_AUTHORITY_POSTURE_VALUES,
  MINT_AUTHORITY_SAFE_SOURCE_VALUES,
  MINT_AUTHORITY_TYPE_VALUES,
  MICA_AUTHORIZATION_TYPE_VALUES,
  ORACLE_RISK_CONFIDENCE_VALUES,
  ORACLE_RISK_TIER_VALUES,
  MICA_STATUS_VALUES,
  MICA_TOKEN_TYPE_VALUES,
  PEG_CURRENCY_VALUES,
  PROOF_OF_RESERVES_CADENCE_VALUES,
  PROOF_OF_RESERVES_TYPE_VALUES,
  STABLECOIN_STATUS_VALUES,
  VARIANT_KIND_VALUES,
  YIELD_TYPE_VALUES,
} from "./core";
import {
  BridgeRouteRiskTierSchema,
  ChainTierSchema,
  CollateralQualitySchema,
  CustodyModelSchema,
  DeploymentModelSchema,
  GovernanceQualitySchema,
  OracleRiskTierSchema,
} from "./core";
import { HttpUrlSchema } from "./validators";

const ContractDecimalsSchema = z.number().finite().int().min(0).max(255);
const DependencyWeightNumberSchema = z.number().finite().positive().max(1);
const BlacklistabilityStatusSchema = z.union([z.boolean(), z.literal("possible")]);
const BlacklistabilityReviewStatusSchema = z.union([BlacklistabilityStatusSchema, z.literal("inherited")]);
const ReviewDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PositiveIntegerSchema = z.number().finite().int().positive();

function isValidIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const StrictIsoDateSchema = z.string().refine(isValidIsoDate, {
  message: "Expected YYYY-MM-DD",
});

export const FuzzyDateSchema = z.string().refine((value) => {
  if (/^\d{4}$/.test(value)) return true;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return true;
  if (/^\d{4}-Q[1-4]$/.test(value)) return true;
  if (/^\d{4}-H[1-2]$/.test(value)) return true;
  return isValidIsoDate(value);
}, {
  message: "Expected YYYY, YYYY-MM, YYYY-MM-DD, YYYY-Q[1-4], or YYYY-H[1-2]",
});

const LocalPathOrHttpUrlSchema = z.union([
  HttpUrlSchema,
  z.string().regex(/^\/[A-Za-z0-9][A-Za-z0-9/_\-.]*$/, "Expected a local absolute asset path"),
]);

const PRIVILEGED_MINT_PATHS = new Set([
  "user-collateralized-governed",
  "issuer-direct-mint",
  "permissioned-minter",
  "offchain-attested-minter",
  "facilitator-bucket-mint",
  "amo-or-custodian-hybrid",
  "bridge-or-oft-synthetic",
  "m0-permissioned-minter",
] satisfies string[]);

const PRIVILEGED_DIRECT_MINT_ABILITIES: ReadonlySet<MintAuthorityDirectMintAbility> = new Set([
  "direct",
  "cap-limited",
  "can-authorize",
  "upgrade-only",
  "parameter-only",
] satisfies MintAuthorityDirectMintAbility[]);

function hasSourceLinks(sources: readonly StablecoinLink[] | undefined): boolean {
  return (sources?.length ?? 0) > 0;
}

function hasText(value: string | null | undefined): boolean {
  return value != null && value.trim().length > 0;
}

export const StablecoinFlagsSchema: z.ZodType<StablecoinFlags> = z
  .object({
    backing: z.enum(BACKING_TYPE_VALUES),
    pegCurrency: z.enum(PEG_CURRENCY_VALUES),
    governance: z.enum(GOVERNANCE_TYPE_VALUES),
    yieldBearing: z.boolean(),
    rwa: z.boolean(),
    navToken: z.boolean(),
  })
  .strict();

export const ProofOfReservesSchema: z.ZodType<ProofOfReserves> = z
  .object({
    type: z.enum(PROOF_OF_RESERVES_TYPE_VALUES),
    url: HttpUrlSchema,
    provider: z.string().optional(),
    attestorTier: z.enum(ATTESTOR_TIER_VALUES).optional(),
    cadence: z.enum(PROOF_OF_RESERVES_CADENCE_VALUES).optional(),
    attestorJurisdiction: z.string().optional(),
    attestorLicense: z.string().optional(),
  })
  .strict();

export const StablecoinLinkSchema: z.ZodType<StablecoinLink> = z
  .object({
    label: z.string(),
    url: HttpUrlSchema,
  })
  .strict();

export const OracleRiskBranchSchema: z.ZodType<OracleRiskBranch> = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    tier: z.enum(ORACLE_RISK_TIER_VALUES),
    summary: z.string().min(12),
    collateralAssets: z.array(z.string().min(1)).min(1).optional(),
    chains: z.array(z.string().min(1)).min(1).optional(),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
  })
  .strict();

export const OracleRiskProfileSchema: z.ZodType<OracleRiskProfile> = z
  .object({
    tier: z.enum(ORACLE_RISK_TIER_VALUES),
    summary: z.string().min(12),
    reviewedAt: ReviewDateSchema.optional(),
    reviewer: z.string().min(1).optional(),
    confidence: z.enum(ORACLE_RISK_CONFIDENCE_VALUES).optional(),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
    branches: z.array(OracleRiskBranchSchema).min(1).optional(),
  })
  .strict();

export const BridgeRouteProtocolEvidenceSchema: z.ZodType<BridgeRouteProtocolEvidence> = z
  .object({
    source: z.enum(BRIDGE_ROUTE_RISK_SOURCE_VALUES),
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    url: HttpUrlSchema.optional(),
    bridgeTypes: z.array(z.string().min(1)).min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

export const BridgeRouteRiskProfileSchema: z.ZodType<BridgeRouteRiskProfile> = z
  .object({
    tier: z.enum(BRIDGE_ROUTE_RISK_TIER_VALUES),
    summary: z.string().min(12),
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    confidence: z.enum(BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES),
    protocols: z.array(BridgeRouteProtocolEvidenceSchema).min(1).optional(),
    sourceFreeRationale: z.string().min(1).optional(),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if ((profile.sources?.length ?? 0) > 0 || profile.sourceFreeRationale || (profile.protocols?.length ?? 0) > 0) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bridgeRouteRisk requires sources, protocols, or sourceFreeRationale",
      path: ["sources"],
    });
  });

export const BlacklistabilityReviewSchema: z.ZodType<BlacklistabilityReview> = z
  .object({
    reviewedStatus: BlacklistabilityReviewStatusSchema,
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
    sourceFreeRationale: z.string().min(1).optional(),
    evidence: z.string().min(12),
    reviewer: z.string().min(1),
    reviewedAt: ReviewDateSchema,
    upstreamSuppressionRationale: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if ((review.sources?.length ?? 0) > 0 || review.sourceFreeRationale) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "blacklistabilityReview requires sources or sourceFreeRationale",
      path: ["sources"],
    });
  });

export const JurisdictionSchema: z.ZodType<Jurisdiction> = z
  .object({
    country: z.string(),
    regulator: z.string().optional(),
    license: z.string().optional(),
  })
  .strict();

export const MicaProfileSchema: z.ZodType<MicaProfile> = z
  .object({
    status: z.enum(MICA_STATUS_VALUES),
    tokenType: z.enum(MICA_TOKEN_TYPE_VALUES).optional(),
    authorizationType: z.enum(MICA_AUTHORIZATION_TYPE_VALUES).optional(),
    competentAuthority: z.string().min(1).optional(),
    authorizedEntity: z.string().min(1).optional(),
    significant: z.boolean().optional(),
    references: z.array(StablecoinLinkSchema).optional(),
  })
  .strict()
  .superRefine((mica, ctx) => {
    if (mica.status === "out-of-scope") {
      for (const field of ["tokenType", "authorizationType", "competentAuthority", "authorizedEntity"] as const) {
        if (mica[field] != null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "mica.out-of-scope rows cannot carry in-scope classification fields",
            path: [field],
          });
        }
      }
    }

    if (mica.status !== "out-of-scope" && (mica.references?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mica.status requires at least one source reference unless it is 'out-of-scope'",
        path: ["references"],
      });
    }
  });

const GENIUS_REGULATOR_SOURCE_KINDS = new Set(["federal-register", "federal-regulator", "state-regulator"]);
const GENIUS_FEDERAL_SOURCE_KINDS = new Set(["federal-register", "federal-regulator"]);

function hasGeniusReferenceKind(
  references: readonly GeniusReference[] | undefined,
  sourceKinds: ReadonlySet<string>,
): boolean {
  return references?.some((reference) => sourceKinds.has(reference.sourceKind)) ?? false;
}

const GeniusReferenceSchema: z.ZodType<GeniusReference> = z
  .object({
    label: z.string().min(1),
    url: HttpUrlSchema,
    sourceKind: z.enum(GENIUS_SOURCE_KIND_VALUES),
    sourceDate: ReviewDateSchema.optional(),
    accessedAt: ReviewDateSchema.optional(),
  })
  .strict();

const GeniusApplicabilityBasisSchema: z.ZodType<GeniusApplicabilityBasis> = z
  .object({
    summary: z.string().min(12),
    references: z.array(GeniusReferenceSchema).optional(),
  })
  .strict();

const GeniusForeignExceptionEvidenceSchema: z.ZodType<GeniusForeignExceptionEvidence> = z
  .object({
    summary: z.string().min(12),
    references: z.array(GeniusReferenceSchema).optional(),
  })
  .strict();

const GeniusNegativeEvidenceReviewSchema: z.ZodType<GeniusNegativeEvidenceReview> = z
  .object({
    sourcesChecked: z.array(z.string().min(1)).min(1),
    summary: z.string().min(12),
    reviewer: z.string().min(1),
    reviewedAt: ReviewDateSchema,
    references: z.array(GeniusReferenceSchema).optional(),
  })
  .strict();

export const GeniusProfileSchema: z.ZodType<GeniusProfile> = z
  .object({
    applicability: z.enum(GENIUS_APPLICABILITY_VALUES),
    applicabilityBasis: GeniusApplicabilityBasisSchema.optional(),
    authorizationStatus: z.enum(GENIUS_AUTHORIZATION_STATUS_VALUES),
    issuerPathway: z.enum(GENIUS_ISSUER_PATHWAY_VALUES),
    issuerEntity: z.string().min(1).optional(),
    issuerDomicile: z.string().min(1).optional(),
    licensingRegulator: z.string().min(1).optional(),
    primaryFederalRegulator: z.enum(GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES).optional(),
    stateRegulator: z.string().min(1).optional(),
    foreignExceptionStatus: z.enum(GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES).optional(),
    foreignExceptionEvidence: GeniusForeignExceptionEvidenceSchema.optional(),
    enforcementStatus: z.enum(GENIUS_ENFORCEMENT_STATUS_VALUES).optional(),
    daspOfferSaleStatus: z.enum(GENIUS_DASP_OFFER_SALE_STATUS_VALUES).optional(),
    reserveDisclosurePresent: z.boolean().optional(),
    reserveDisclosureUrl: HttpUrlSchema.optional(),
    redemptionPolicyPresent: z.boolean().optional(),
    monthlyAttestationPresent: z.boolean().optional(),
    latestReportDate: ReviewDateSchema.optional(),
    notes: z.string().min(1).optional(),
    references: z.array(GeniusReferenceSchema).optional(),
    negativeEvidenceReview: GeniusNegativeEvidenceReviewSchema.optional(),
    reviewer: z.string().min(1),
    reviewedAt: ReviewDateSchema,
  })
  .strict()
  .superRefine((genius, ctx) => {
    if (
      (genius.authorizationStatus === "ppsi-approved" ||
        genius.authorizationStatus === "state-qualified" ||
        genius.authorizationStatus === "official-application-pending") &&
      !hasGeniusReferenceKind(genius.references, GENIUS_REGULATOR_SOURCE_KINDS)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS official authorization statuses require a federal, state, or Federal Register reference",
        path: ["references"],
      });
    }

    if (
      genius.authorizationStatus === "issuer-announced-intent" &&
      !hasGeniusReferenceKind(
        genius.references,
        new Set(["issuer-disclosure", "issuer-filing", ...GENIUS_REGULATOR_SOURCE_KINDS]),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS issuer-announced-intent requires an issuer, regulator, or filing reference",
        path: ["references"],
      });
    }

    if (genius.authorizationStatus === "no-public-authorization-found" && genius.negativeEvidenceReview == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS no-public-authorization-found requires a negative evidence review",
        path: ["negativeEvidenceReview"],
      });
    }

    if (genius.reserveDisclosurePresent === true && !genius.reserveDisclosureUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS reserve disclosure presence requires a reserve disclosure URL",
        path: ["reserveDisclosureUrl"],
      });
    }

    if (
      genius.foreignExceptionStatus === "registered-exception" &&
      (genius.foreignExceptionEvidence == null ||
        !hasGeniusReferenceKind(genius.foreignExceptionEvidence.references, GENIUS_FEDERAL_SOURCE_KINDS))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "GENIUS registered foreign exception requires evidence with a federal regulator or Federal Register reference",
        path: ["foreignExceptionEvidence"],
      });
    }

    if (
      (genius.enforcementStatus === "warning-or-notice" || genius.enforcementStatus === "prohibited-or-revoked") &&
      !hasGeniusReferenceKind(genius.references, GENIUS_REGULATOR_SOURCE_KINDS)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS enforcement actions require a federal, state, or Federal Register reference",
        path: ["references"],
      });
    }
  });

const MintAuthoritySafeStateSchema: z.ZodType<MintAuthoritySafeState> = z
  .object({
    version: z.string().min(1).optional(),
    owners: z.array(z.string().min(1)).optional(),
    threshold: PositiveIntegerSchema.optional(),
    enabledModules: z.array(z.string().min(1)).optional(),
    guard: z.string().min(1).nullable().optional(),
    moduleGuard: z.string().min(1).nullable().optional(),
    fallbackHandler: z.string().min(1).nullable().optional(),
    masterCopy: z.string().min(1).nullable().optional(),
    observedBlock: PositiveIntegerSchema.optional(),
    source: z.enum(MINT_AUTHORITY_SAFE_SOURCE_VALUES),
  })
  .strict()
  .superRefine((safe, ctx) => {
    if (safe.threshold != null && safe.owners != null && safe.threshold > safe.owners.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "safe.threshold cannot exceed safe.owners length",
        path: ["threshold"],
      });
    }
  });

const MintAuthorityRouteChecksSchema: z.ZodType<MintAuthorityRouteChecks> = z
  .object({
    lockboxOrEscrow: z.string().min(1).optional(),
    trustedPeerOrRemote: z.string().min(1).optional(),
    attestorQuorum: z.string().min(1).optional(),
    signingModel: z.string().min(1).optional(),
    rateLimits: z.string().min(1).optional(),
    caps: z.string().min(1).optional(),
    pausersAdminsUpgraders: z.string().min(1).optional(),
    onchainAmountBounds: z.string().min(1).optional(),
    unsupportedReason: z.string().min(1).optional(),
  })
  .strict();

const MintAuthorityKeyCustodyAttestationSchema: z.ZodType<NonNullable<MintAuthorityControl["keyCustodyAttestation"]>> =
  z
    .object({
      kind: z.enum(MINT_AUTHORITY_KEY_CUSTODY_ATTESTATION_KIND_VALUES),
      sources: z.array(StablecoinLinkSchema).min(1),
    })
    .strict();

const MintAuthorityControlSchema: z.ZodType<MintAuthorityControl> = z
  .object({
    chain: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    label: z.string().min(1),
    role: z.enum(MINT_AUTHORITY_CONTROL_ROLE_VALUES),
    authorityType: z.enum(MINT_AUTHORITY_TYPE_VALUES),
    directMintAbility: z.enum(MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES),
    threshold: PositiveIntegerSchema.optional(),
    signerCount: PositiveIntegerSchema.optional(),
    timelockDelaySec: z.number().finite().int().min(0).optional(),
    capDescription: z.string().min(1).optional(),
    canRaiseCap: z.union([z.boolean(), z.literal("unknown")]).optional(),
    modulesOrGuardsStatus: z.enum(MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES).optional(),
    safe: MintAuthoritySafeStateSchema.optional(),
    routeChecks: MintAuthorityRouteChecksSchema.optional(),
    keyCustodyAttestation: MintAuthorityKeyCustodyAttestationSchema.optional(),
    bypassSurfaces: z.array(z.string().min(1)).optional(),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
    evidence: z.string().min(12).optional(),
  })
  .strict()
  .superRefine((control, ctx) => {
    if (control.threshold != null && control.signerCount != null && control.threshold > control.signerCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "threshold cannot exceed signerCount",
        path: ["threshold"],
      });
    }

    if (control.safe != null && control.authorityType !== "safe") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "safe details are only allowed when authorityType is safe",
        path: ["safe"],
      });
    }

    if (control.safe?.threshold != null && control.threshold != null && control.safe.threshold !== control.threshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "safe.threshold must match threshold when both are present",
        path: ["safe", "threshold"],
      });
    }

    if (
      control.safe?.owners != null &&
      control.signerCount != null &&
      control.safe.owners.length !== control.signerCount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "safe.owners length must match signerCount when both are present",
        path: ["safe", "owners"],
      });
    }
  });

const MintAuthorityReviewSchema: z.ZodType<MintAuthorityReview> = z
  .object({
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
    sourceFreeRationale: z.string().min(1).optional(),
    evidence: z.string().min(24),
    reviewer: z.string().min(1),
    reviewedAt: ReviewDateSchema,
    unresolvedQuestions: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (hasSourceLinks(review.sources) || review.sourceFreeRationale) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mintAuthority.review requires sources or sourceFreeRationale",
      path: ["sources"],
    });
  });

const MintAuthorityIncidentSchema: z.ZodType<NonNullable<MintAuthorityProfile["mintIncidents"]>[number]> = z
  .object({
    date: ReviewDateSchema,
    summary: z.string().min(12),
    sources: z.array(StablecoinLinkSchema).min(1),
  })
  .strict();

export const MintAuthorityProfileSchema: z.ZodType<MintAuthorityProfile> = z
  .object({
    mintPath: z.enum(MINT_AUTHORITY_MINT_PATH_VALUES),
    authorityPosture: z.enum(MINT_AUTHORITY_POSTURE_VALUES),
    confidence: z.enum(MINT_AUTHORITY_CONFIDENCE_VALUES),
    summary: z.string().min(12),
    inheritedFrom: z.string().min(1).optional(),
    mintIncidents: z.array(MintAuthorityIncidentSchema).min(1).optional(),
    controls: z.array(MintAuthorityControlSchema).optional(),
    review: MintAuthorityReviewSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    const controls = profile.controls ?? [];
    const profileHasSourceLinks = hasSourceLinks(profile.review.sources);
    const controlsHaveSourceLinks = controls.some((control) => hasSourceLinks(control.sources));

    if (
      (profile.confidence === "verified" || profile.confidence === "probable") &&
      !profileHasSourceLinks &&
      !controlsHaveSourceLinks
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verified or probable mintAuthority confidence requires at least one source link",
        path: ["review", "sources"],
      });
    }

    if (PRIVILEGED_MINT_PATHS.has(profile.mintPath) && profile.confidence !== "unknown" && controls.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "privileged mintAuthority mintPath requires at least one control when confidence is not unknown",
        path: ["controls"],
      });
    }

    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index]!;
      const controlHasSourceLinks = hasSourceLinks(control.sources);
      const controlHasEvidence = hasText(control.evidence);
      const directMintAbilityNeedsEvidence = control.directMintAbility !== "none";

      if (
        (control.address != null || directMintAbilityNeedsEvidence) &&
        !controlHasSourceLinks &&
        !controlHasEvidence &&
        !profileHasSourceLinks
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "addressed or mint-capable controls require control-level sources/evidence or profile-level sources",
          path: ["controls", index, "sources"],
        });
      }

      if (
        control.address == null &&
        !controlHasSourceLinks &&
        !controlHasEvidence &&
        !profile.review.sourceFreeRationale &&
        (profile.review.unresolvedQuestions?.length ?? 0) === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "non-addressable controls require evidence, sources, sourceFreeRationale, or unresolvedQuestions",
          path: ["controls", index, "address"],
        });
      }

      if (control.authorityType === "safe" && control.safe == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "authorityType safe requires safe details",
          path: ["controls", index, "safe"],
        });
      }

      if (
        (control.authorityType === "safe" || control.authorityType === "multisig") &&
        profile.confidence === "verified"
      ) {
        if (control.threshold == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "verified safe or multisig controls require threshold",
            path: ["controls", index, "threshold"],
          });
        }
        if (control.signerCount == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "verified safe or multisig controls require signerCount",
            path: ["controls", index, "signerCount"],
          });
        }
        if (control.modulesOrGuardsStatus == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "verified safe or multisig controls require modulesOrGuardsStatus",
            path: ["controls", index, "modulesOrGuardsStatus"],
          });
        }
        if (
          control.authorityType === "safe" &&
          control.safe != null &&
          control.safe.source !== "manual" &&
          control.safe.observedBlock == null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "verified onchain or safe-api Safe controls require observedBlock",
            path: ["controls", index, "safe", "observedBlock"],
          });
        }
      }

      if (
        (control.authorityType === "safe" || control.authorityType === "multisig") &&
        (profile.confidence === "verified" || profile.confidence === "probable") &&
        control.modulesOrGuardsStatus === "unknown"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unknown Safe modules/guards status caps confidence at manual-review",
          path: ["controls", index, "modulesOrGuardsStatus"],
        });
      }
    }

    if (profile.authorityPosture === "none-resolved") {
      if (profile.mintPath !== "immutable-user-collateralized" && profile.mintPath !== "wrapped-or-variant-inherited") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "authorityPosture none-resolved requires a non-privileged mintPath",
          path: ["authorityPosture"],
        });
      }

      const privilegedControlIndex = controls.findIndex((control) =>
        PRIVILEGED_DIRECT_MINT_ABILITIES.has(control.directMintAbility),
      );
      if (privilegedControlIndex >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "authorityPosture none-resolved cannot include mint-capable controls",
          path: ["controls", privilegedControlIndex, "directMintAbility"],
        });
      }
    }

    if (
      profile.mintPath === "unknown" &&
      profile.authorityPosture !== "unknown" &&
      profile.authorityPosture !== "unbounded-or-compromised"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "mintPath unknown should use authorityPosture unknown unless evidence supports unbounded-or-compromised",
        path: ["authorityPosture"],
      });
    }
  });

export const ContractDeploymentSchema: z.ZodType<ContractDeployment> = z
  .object({
    chain: z.string(),
    address: z.string(),
    decimals: ContractDecimalsSchema,
  })
  .strict();

export const DependencyWeightSchema: z.ZodType<DependencyWeight> = z
  .object({
    id: z.string(),
    weight: DependencyWeightNumberSchema,
    type: z.enum(DEPENDENCY_TYPE_VALUES).optional(),
  })
  .strict();

export const CoinNoticeSchema: z.ZodType<CoinNotice> = z
  .object({
    type: z.enum(COIN_NOTICE_TYPE_VALUES),
    title: z.string(),
    message: z.string(),
  })
  .strict();

export const YieldConfigSchema: z.ZodType<YieldConfig> = z
  .object({
    defiLlamaPoolId: z.string().optional(),
    yieldSource: z.string(),
    yieldType: z.enum(YIELD_TYPE_VALUES),
  })
  .strict();

export const LaunchMilestoneSchema: z.ZodType<LaunchMilestone> = z
  .object({
    date: FuzzyDateSchema,
    type: z.enum(LAUNCH_MILESTONE_TYPE_VALUES),
    title: z.string(),
    description: z.string().optional(),
    sourceUrl: HttpUrlSchema.optional(),
  })
  .strict();

export const DateHistoryEntrySchema: z.ZodType<DateHistoryEntry> = z
  .object({
    date: FuzzyDateSchema,
    setOn: StrictIsoDateSchema,
  })
  .strict();

export const FeaturedContentSchema: z.ZodType<FeaturedContent> = z
  .object({
    type: z.enum(FEATURED_CONTENT_TYPE_VALUES),
    url: HttpUrlSchema,
    title: z.string(),
    description: z.string().optional(),
    image: LocalPathOrHttpUrlSchema.optional(),
    source: z.string().optional(),
  })
  .strict();

export const StablecoinMetaEnumSchemas = {
  chainTier: ChainTierSchema,
  deploymentModel: DeploymentModelSchema,
  collateralQuality: CollateralQualitySchema,
  custodyModel: CustodyModelSchema,
  governanceQuality: GovernanceQualitySchema,
  oracleRiskTier: OracleRiskTierSchema,
  bridgeRouteRiskTier: BridgeRouteRiskTierSchema,
  infrastructures: z.array(z.enum(INFRASTRUCTURE_VALUES)),
  variantKind: z.enum(VARIANT_KIND_VALUES),
  launchPhase: z.enum(LAUNCH_PHASE_VALUES),
  marketAvailability: z.enum(MARKET_AVAILABILITY_VALUES),
  status: z.enum(STABLECOIN_STATUS_VALUES),
  mechanismArchetype: z.enum(MECHANISM_ARCHETYPE_VALUES),
} as const;
