import { z } from "zod";
import type {
  BlacklistabilityReview,
  CoinNotice,
  ContractDeployment,
  DateHistoryEntry,
  DependencyWeight,
  FeaturedContent,
  Jurisdiction,
  LaunchMilestone,
  MicaProfile,
  MintAuthorityControl,
  MintAuthorityDirectMintAbility,
  MintAuthorityProfile,
  MintAuthorityReview,
  MintAuthorityRouteChecks,
  MintAuthoritySafeState,
  ProofOfReserves,
  StablecoinFlags,
  StablecoinLink,
  YieldConfig,
} from "./core";
import {
  ATTESTOR_TIER_VALUES,
  BACKING_TYPE_VALUES,
  COIN_NOTICE_TYPE_VALUES,
  COLLATERAL_QUALITY_VALUES,
  CUSTODY_MODEL_VALUES,
  DEPENDENCY_TYPE_VALUES,
  DEPLOYMENT_MODEL_VALUES,
  FEATURED_CONTENT_TYPE_VALUES,
  GOVERNANCE_QUALITY_VALUES,
  GOVERNANCE_TYPE_VALUES,
  INFRASTRUCTURE_VALUES,
  LAUNCH_MILESTONE_TYPE_VALUES,
  LAUNCH_PHASE_VALUES,
  MECHANISM_ARCHETYPE_VALUES,
  MINT_AUTHORITY_CONFIDENCE_VALUES,
  MINT_AUTHORITY_CONTROL_ROLE_VALUES,
  MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES,
  MINT_AUTHORITY_MINT_PATH_VALUES,
  MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES,
  MINT_AUTHORITY_POSTURE_VALUES,
  MINT_AUTHORITY_SAFE_SOURCE_VALUES,
  MINT_AUTHORITY_TYPE_VALUES,
  MICA_AUTHORIZATION_TYPE_VALUES,
  MICA_STATUS_VALUES,
  MICA_TOKEN_TYPE_VALUES,
  PEG_CURRENCY_VALUES,
  PROOF_OF_RESERVES_CADENCE_VALUES,
  PROOF_OF_RESERVES_TYPE_VALUES,
  STABLECOIN_STATUS_VALUES,
  VARIANT_KIND_VALUES,
  YIELD_TYPE_VALUES,
  CHAIN_TIER_VALUES,
} from "./core";

const ContractDecimalsSchema = z.number().finite().int().min(0).max(255);
const DependencyWeightNumberSchema = z.number().finite().positive().max(1);
const BlacklistabilityStatusSchema = z.union([z.boolean(), z.literal("possible"), z.literal("dilutable")]);
const BlacklistabilityReviewStatusSchema = z.union([BlacklistabilityStatusSchema, z.literal("inherited")]);
const ReviewDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PositiveIntegerSchema = z.number().finite().int().positive();

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

export const StablecoinFlagsSchema: z.ZodType<StablecoinFlags> = z.object({
  backing: z.enum(BACKING_TYPE_VALUES),
  pegCurrency: z.enum(PEG_CURRENCY_VALUES),
  governance: z.enum(GOVERNANCE_TYPE_VALUES),
  yieldBearing: z.boolean(),
  rwa: z.boolean(),
  navToken: z.boolean(),
}).strict();

export const ProofOfReservesSchema: z.ZodType<ProofOfReserves> = z.object({
  type: z.enum(PROOF_OF_RESERVES_TYPE_VALUES),
  url: z.string(),
  provider: z.string().optional(),
  attestorTier: z.enum(ATTESTOR_TIER_VALUES).optional(),
  cadence: z.enum(PROOF_OF_RESERVES_CADENCE_VALUES).optional(),
  attestorJurisdiction: z.string().optional(),
  attestorLicense: z.string().optional(),
}).strict();

export const StablecoinLinkSchema: z.ZodType<StablecoinLink> = z.object({
  label: z.string(),
  url: z.string(),
}).strict();

export const BlacklistabilityReviewSchema: z.ZodType<BlacklistabilityReview> = z.object({
  reviewedStatus: BlacklistabilityReviewStatusSchema,
  sources: z.array(StablecoinLinkSchema).min(1).optional(),
  sourceFreeRationale: z.string().min(1).optional(),
  evidence: z.string().min(12),
  reviewer: z.string().min(1),
  reviewedAt: ReviewDateSchema,
  upstreamSuppressionRationale: z.string().min(1).optional(),
}).strict().superRefine((review, ctx) => {
  if ((review.sources?.length ?? 0) > 0 || review.sourceFreeRationale) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "blacklistabilityReview requires sources or sourceFreeRationale",
    path: ["sources"],
  });
});

export const JurisdictionSchema: z.ZodType<Jurisdiction> = z.object({
  country: z.string(),
  regulator: z.string().optional(),
  license: z.string().optional(),
}).strict();

export const MicaProfileSchema: z.ZodType<MicaProfile> = z.object({
  status: z.enum(MICA_STATUS_VALUES),
  tokenType: z.enum(MICA_TOKEN_TYPE_VALUES).optional(),
  authorizationType: z.enum(MICA_AUTHORIZATION_TYPE_VALUES).optional(),
  competentAuthority: z.string().min(1).optional(),
  authorizedEntity: z.string().min(1).optional(),
  significant: z.boolean().optional(),
  references: z.array(StablecoinLinkSchema).optional(),
}).strict().superRefine((mica, ctx) => {
  if (mica.status === "authorized" && (mica.references?.length ?? 0) === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mica.status 'authorized' requires at least one register reference",
      path: ["references"],
    });
  }
});

export const MintAuthoritySafeStateSchema: z.ZodType<MintAuthoritySafeState> = z.object({
  version: z.string().min(1).optional(),
  owners: z.array(z.string().min(1)).optional(),
  threshold: PositiveIntegerSchema.optional(),
  enabledModules: z.array(z.string().min(1)).optional(),
  guard: z.string().min(1).nullable().optional(),
  moduleGuard: z.string().min(1).nullable().optional(),
  fallbackHandler: z.string().min(1).nullable().optional(),
  observedBlock: PositiveIntegerSchema.optional(),
  source: z.enum(MINT_AUTHORITY_SAFE_SOURCE_VALUES),
}).strict().superRefine((safe, ctx) => {
  if (safe.threshold != null && safe.owners != null && safe.threshold > safe.owners.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "safe.threshold cannot exceed safe.owners length",
      path: ["threshold"],
    });
  }
});

export const MintAuthorityRouteChecksSchema: z.ZodType<MintAuthorityRouteChecks> = z.object({
  lockboxOrEscrow: z.string().min(1).optional(),
  trustedPeerOrRemote: z.string().min(1).optional(),
  attestorQuorum: z.string().min(1).optional(),
  signingModel: z.string().min(1).optional(),
  rateLimits: z.string().min(1).optional(),
  caps: z.string().min(1).optional(),
  pausersAdminsUpgraders: z.string().min(1).optional(),
  onchainAmountBounds: z.string().min(1).optional(),
  unsupportedReason: z.string().min(1).optional(),
}).strict();

export const MintAuthorityControlSchema: z.ZodType<MintAuthorityControl> = z.object({
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
  bypassSurfaces: z.array(z.string().min(1)).optional(),
  sources: z.array(StablecoinLinkSchema).min(1).optional(),
  evidence: z.string().min(12).optional(),
}).strict().superRefine((control, ctx) => {
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

  if (control.safe?.owners != null && control.signerCount != null && control.safe.owners.length !== control.signerCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "safe.owners length must match signerCount when both are present",
      path: ["safe", "owners"],
    });
  }
});

export const MintAuthorityReviewSchema: z.ZodType<MintAuthorityReview> = z.object({
  sources: z.array(StablecoinLinkSchema).min(1).optional(),
  sourceFreeRationale: z.string().min(1).optional(),
  evidence: z.string().min(24),
  reviewer: z.string().min(1),
  reviewedAt: ReviewDateSchema,
  unresolvedQuestions: z.array(z.string().min(1)).optional(),
}).strict().superRefine((review, ctx) => {
  if (hasSourceLinks(review.sources) || review.sourceFreeRationale) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "mintAuthority.review requires sources or sourceFreeRationale",
    path: ["sources"],
  });
});

export const MintAuthorityProfileSchema: z.ZodType<MintAuthorityProfile> = z.object({
  mintPath: z.enum(MINT_AUTHORITY_MINT_PATH_VALUES),
  authorityPosture: z.enum(MINT_AUTHORITY_POSTURE_VALUES),
  confidence: z.enum(MINT_AUTHORITY_CONFIDENCE_VALUES),
  summary: z.string().min(12),
  inheritedFrom: z.string().min(1).optional(),
  controls: z.array(MintAuthorityControlSchema).optional(),
  review: MintAuthorityReviewSchema,
}).strict().superRefine((profile, ctx) => {
  const controls = profile.controls ?? [];
  const profileHasSourceLinks = hasSourceLinks(profile.review.sources);

  if ((profile.confidence === "verified" || profile.confidence === "probable") && !profileHasSourceLinks) {
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

    if ((control.address != null || directMintAbilityNeedsEvidence) && !controlHasSourceLinks && !controlHasEvidence && !profileHasSourceLinks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "addressed or mint-capable controls require control-level sources/evidence or profile-level sources",
        path: ["controls", index, "sources"],
      });
    }

    if (control.address == null && !controlHasSourceLinks && !controlHasEvidence && !profile.review.sourceFreeRationale && (profile.review.unresolvedQuestions?.length ?? 0) === 0) {
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

    if ((control.authorityType === "safe" || control.authorityType === "multisig") && profile.confidence === "verified") {
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

    const privilegedControlIndex = controls.findIndex((control) => (
      PRIVILEGED_DIRECT_MINT_ABILITIES.has(control.directMintAbility)
    ));
    if (privilegedControlIndex >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorityPosture none-resolved cannot include mint-capable controls",
        path: ["controls", privilegedControlIndex, "directMintAbility"],
      });
    }
  }

  if (profile.mintPath === "unknown" && profile.authorityPosture !== "unknown" && profile.authorityPosture !== "unbounded-or-compromised") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mintPath unknown should use authorityPosture unknown unless evidence supports unbounded-or-compromised",
      path: ["authorityPosture"],
    });
  }
});

export const ContractDeploymentSchema: z.ZodType<ContractDeployment> = z.object({
  chain: z.string(),
  address: z.string(),
  decimals: ContractDecimalsSchema,
}).strict();

export const DependencyWeightSchema: z.ZodType<DependencyWeight> = z.object({
  id: z.string(),
  weight: DependencyWeightNumberSchema,
  type: z.enum(DEPENDENCY_TYPE_VALUES).optional(),
}).strict();

export const CoinNoticeSchema: z.ZodType<CoinNotice> = z.object({
  type: z.enum(COIN_NOTICE_TYPE_VALUES),
  title: z.string(),
  message: z.string(),
}).strict();

export const YieldConfigSchema: z.ZodType<YieldConfig> = z.object({
  defiLlamaPoolId: z.string().optional(),
  yieldSource: z.string(),
  yieldType: z.enum(YIELD_TYPE_VALUES),
}).strict();

export const LaunchMilestoneSchema: z.ZodType<LaunchMilestone> = z.object({
  date: z.string(),
  type: z.enum(LAUNCH_MILESTONE_TYPE_VALUES),
  title: z.string(),
  description: z.string().optional(),
  sourceUrl: z.string().optional(),
}).strict();

export const DateHistoryEntrySchema: z.ZodType<DateHistoryEntry> = z.object({
  date: z.string(),
  setOn: z.string(),
}).strict();

export const FeaturedContentSchema: z.ZodType<FeaturedContent> = z.object({
  type: z.enum(FEATURED_CONTENT_TYPE_VALUES),
  url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  image: z.string().optional(),
  source: z.string().optional(),
}).strict();

export const StablecoinMetaEnumSchemas = {
  chainTier: z.enum(CHAIN_TIER_VALUES),
  deploymentModel: z.enum(DEPLOYMENT_MODEL_VALUES),
  collateralQuality: z.enum(COLLATERAL_QUALITY_VALUES),
  custodyModel: z.enum(CUSTODY_MODEL_VALUES),
  governanceQuality: z.enum(GOVERNANCE_QUALITY_VALUES),
  infrastructures: z.array(z.enum(INFRASTRUCTURE_VALUES)),
  variantKind: z.enum(VARIANT_KIND_VALUES),
  launchPhase: z.enum(LAUNCH_PHASE_VALUES),
  status: z.enum(STABLECOIN_STATUS_VALUES),
  mechanismArchetype: z.enum(MECHANISM_ARCHETYPE_VALUES),
} as const;
