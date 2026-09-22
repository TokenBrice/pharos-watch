import { z } from "zod";
import {
  ATTESTOR_TIER_VALUES,
  BACKING_TYPE_VALUES,
  COIN_NOTICE_TYPE_VALUES,
  DEPENDENCY_TYPE_VALUES,
  V9_DEPENDENCY_ECONOMIC_ROLE_VALUES,
  FEATURED_CONTENT_TYPE_VALUES,
  GOVERNANCE_TYPE_VALUES,
  INFRASTRUCTURE_VALUES,
  LAUNCH_MILESTONE_TYPE_VALUES,
  LAUNCH_PHASE_VALUES,
  MARKET_AVAILABILITY_VALUES,
  MECHANISM_ARCHETYPE_VALUES,
  MECHANISM_ARCHETYPE_REVIEW_DISPOSITION_VALUES,
  RESEARCH_REVIEW_CONFIDENCE_VALUES,
  RESERVE_NON_LINK_DISPOSITION_VALUES,
  RESERVE_REVIEW_SCOPE_VALUES,
  PEG_CURRENCY_VALUES,
  PROOF_OF_RESERVES_CADENCE_VALUES,
  PROOF_OF_RESERVES_TYPE_VALUES,
  PROOF_ASSURANCE_METHOD_VALUES,
  PROOF_ASSURANCE_SCOPE_VALUES,
  LIABILITY_RECONCILIATION_VALUES,
  CUSTODY_PROVIDER_ROLE_VALUES,
  CUSTODY_SEGREGATION_VALUES,
  CUSTODY_BANKRUPTCY_REMOTENESS_VALUES,
  CUSTODY_REHYPOTHECATION_VALUES,
  STABLECOIN_STATUS_VALUES,
  STABLECOIN_EXIT_MECHANISM_VALUES,
  STABLECOIN_PRICE_BASIS_VALUES,
  VARIANT_KIND_VALUES,
  WRAPPER_OPERATOR_VALUES,
  YIELD_TYPE_VALUES,
} from "./core";
import {
  BridgeRouteRiskTierSchema,
  CollateralQualitySchema,
  CustodyModelSchema,
  GovernanceQualitySchema,
  OracleRiskTierSchema,
} from "./core";
import { HttpUrlSchema } from "./validators";
import { StrictIsoDateSchema } from "./safety-schema-primitives";

const ContractDecimalsSchema = z.number().finite().int().min(0).max(255);
const DependencyWeightNumberSchema = z.number().finite().positive().max(1);
export const BlacklistabilityReviewStatusSchema = z.union([
  z.boolean(),
  z.literal("possible"),
  z.literal("inherited"),
]);
export const PositiveIntegerSchema = z.number().finite().int().positive();

export const ReviewDateSchema = StrictIsoDateSchema;

// Shape only. `shared/types` must not import `shared/lib`, so the canonical-form
// check stays with the single normalizer: `validateMintBridgeOwnership()` raises
// `non-normalized-deployment-ref` for an id that parses but is not already
// normalized, and it runs in the merged catalog schema, `check:stablecoin-data`,
// and the V9 compiler defence. Duplicating `normalizeDeploymentId` here would
// create a second normalization authority, which the authoring contract forbids.
export const DeploymentIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*:\S+$/, "Expected a chain:contractAddress deployment ID");
export const DeploymentRefsSchema = z
  .array(DeploymentIdSchema)
  .min(1)
  .refine((refs) => new Set(refs).size === refs.length, {
    message: "deploymentRefs must be unique",
  });

export const FuzzyDateSchema = z.string().refine(
  (value) => {
    if (/^\d{4}$/.test(value)) return true;
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return true;
    if (/^\d{4}-Q[1-4]$/.test(value)) return true;
    if (/^\d{4}-H[1-2]$/.test(value)) return true;
    return StrictIsoDateSchema.safeParse(value).success;
  },
  {
    message: "Expected YYYY, YYYY-MM, YYYY-MM-DD, YYYY-Q[1-4], or YYYY-H[1-2]",
  },
);

const LocalPathOrHttpUrlSchema = z.union([
  HttpUrlSchema,
  z.string().regex(/^\/[A-Za-z0-9][A-Za-z0-9/_\-.]*$/, "Expected a local absolute asset path"),
]);

/**
 * Source coin files omit the four modal members below; the schema supplies them.
 * `backing` and `governance` have no dominant value and stay required. Parsed
 * output is always the full flag set, so every generated aggregate and runtime
 * consumer still sees explicit values.
 */
export const StablecoinFlagsSchema = z
  .object({
    backing: z.enum(BACKING_TYPE_VALUES),
    pegCurrency: z.enum(PEG_CURRENCY_VALUES).default("USD"),
    governance: z.enum(GOVERNANCE_TYPE_VALUES),
    yieldBearing: z.boolean().default(false),
    rwa: z.boolean().default(false),
    navToken: z.boolean().default(false),
  })
  .strict();

export const StablecoinLinkSchema = z
  .object({
    /**
     * editorial-selector identity for links whose url is not unique within the
     * coin; immutable after publication.
     */
    id: z
      .string()
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored kebab-case id; finite groups, no backtracking ambiguity.
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected a kebab-case link id")
      .optional(),
    label: z.string(),
    url: HttpUrlSchema,
    /**
     * Marks the label as a verbatim external title (an article headline, filing
     * name, or document title) rather than Pharos-composed copy. Editorial style
     * rules never apply to quoted text, so the corpus gate reads this as
     * `ownership: "quoted"` and skips the record, and label punctuation
     * migrations must leave it untouched. See docs/editorial-style.md.
     */
    quoted: z.boolean().optional(),
  })
  .strict();

export const MechanismArchetypeReviewSchema = z
  .object({
    disposition: z.enum(MECHANISM_ARCHETYPE_REVIEW_DISPOSITION_VALUES),
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    rationale: z.string().min(12),
    sources: z.array(StablecoinLinkSchema).min(1),
  })
  .strict();

export const ProofOfReservesSchema = z
  .object({
    type: z.enum(PROOF_OF_RESERVES_TYPE_VALUES),
    url: HttpUrlSchema,
    provider: z.string().optional(),
    attestorTier: z.enum(ATTESTOR_TIER_VALUES).optional(),
    cadence: z.enum(PROOF_OF_RESERVES_CADENCE_VALUES).optional(),
    attestorJurisdiction: z.string().optional(),
    attestorLicense: z.string().optional(),
    latestReport: z
      .object({
        periodEnd: StrictIsoDateSchema,
        publishedAt: StrictIsoDateSchema,
        assuranceMethod: z.enum(PROOF_ASSURANCE_METHOD_VALUES),
        scope: z.enum(PROOF_ASSURANCE_SCOPE_VALUES),
        liabilityReconciliation: z.enum(LIABILITY_RECONCILIATION_VALUES),
        reviewer: z.string().min(1),
        confidence: z.enum(RESEARCH_REVIEW_CONFIDENCE_VALUES),
        sources: z.array(StablecoinLinkSchema).min(1),
      })
      .strict()
      .superRefine((report, ctx) => {
        if (report.publishedAt < report.periodEnd) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "latestReport publishedAt cannot precede periodEnd",
            path: ["publishedAt"],
          });
        }
        if (
          report.scope === "assets-and-liabilities" &&
          (report.liabilityReconciliation === "none" || report.liabilityReconciliation === "unknown")
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "assets-and-liabilities scope requires full or partial liability reconciliation",
            path: ["liabilityReconciliation"],
          });
        }
      })
      .optional(),
  })
  .strict();

export type StablecoinFlags = z.infer<typeof StablecoinFlagsSchema>;
export type StablecoinLink = z.infer<typeof StablecoinLinkSchema>;
export type MechanismArchetypeReview = z.infer<typeof MechanismArchetypeReviewSchema>;
export type ProofOfReserves = z.infer<typeof ProofOfReservesSchema>;
export type ProofOfReservesLatestReport = NonNullable<ProofOfReserves["latestReport"]>;
export const ContractDeploymentSchema = z
  .object({
    chain: z.string(),
    address: z.string(),
    decimals: ContractDecimalsSchema,
  })
  .strict();

export const DependencyWeightSchema = z
  .object({
    id: z.string(),
    weight: DependencyWeightNumberSchema,
    type: z.enum(DEPENDENCY_TYPE_VALUES).optional(),
  })
  .strict();

export const ReserveReviewSchema = z
  .object({
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    confidence: z.enum(RESEARCH_REVIEW_CONFIDENCE_VALUES),
    sources: z.array(StablecoinLinkSchema).min(1),
    rationale: z.string().min(1),
    compositionBasis: z.string().min(1),
    compositionAsOf: StrictIsoDateSchema.optional(),
    scope: z.enum(RESERVE_REVIEW_SCOPE_VALUES),
    knownUnknownExposure: z.string().min(1),
    knownUnknownExposurePct: z.number().finite().min(0).max(100),
    nonLinkDispositions: z
      .array(
        z
          .object({
            reserveIndex: z.number().int().nonnegative(),
            reserveName: z.string().min(1),
            pct: z.number().finite().positive().max(100),
            disposition: z.enum(RESERVE_NON_LINK_DISPOSITION_VALUES),
            rationale: z.string().min(1),
            candidateCoinIds: z.array(z.string().min(1)).min(1).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const CustodyProfileSchema = z
  .object({
    providers: z
      .array(
        z
          .object({
            name: z.string().min(1),
            role: z.enum(CUSTODY_PROVIDER_ROLE_VALUES),
            /** Percentage points on a 0-100 scale, not a 0-1 ratio. */
            sharePct: z.number().finite().min(0).max(100).optional(),
            jurisdiction: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    segregation: z.enum(CUSTODY_SEGREGATION_VALUES),
    bankruptcyRemoteness: z.enum(CUSTODY_BANKRUPTCY_REMOTENESS_VALUES),
    rehypothecation: z.enum(CUSTODY_REHYPOTHECATION_VALUES),
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    confidence: z.enum(RESEARCH_REVIEW_CONFIDENCE_VALUES),
    sources: z.array(StablecoinLinkSchema).min(1),
    uncertainty: z.string().min(1),
    knownUnknownExposurePct: z.number().finite().min(0).max(100).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const knownShares = profile.providers.reduce((sum, provider) => sum + (provider.sharePct ?? 0), 0);
    if (knownShares > 100.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custody provider shares cannot exceed 100%",
        path: ["providers"],
      });
    }
    if (profile.knownUnknownExposurePct != null && knownShares + profile.knownUnknownExposurePct > 100.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custody provider shares plus known unknown exposure cannot exceed 100%",
        path: ["knownUnknownExposurePct"],
      });
    }
  });

export const DependencyReviewSchema = z
  .object({
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    confidence: z.enum(RESEARCH_REVIEW_CONFIDENCE_VALUES),
    sources: z.array(StablecoinLinkSchema).min(1),
    rationale: z.string().min(1),
    relationships: z
      .array(
        z
          .object({
            id: z.string().min(1),
            weight: DependencyWeightNumberSchema,
            type: z.enum(DEPENDENCY_TYPE_VALUES),
            economicRole: z.enum(V9_DEPENDENCY_ECONOMIC_ROLE_VALUES).optional(),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const CoinNoticeSchema = z
  .object({
    type: z.enum(COIN_NOTICE_TYPE_VALUES),
    title: z.string(),
    message: z.string(),
  })
  .strict();

export const YieldConfigSchema = z
  .object({
    defiLlamaPoolId: z.string().optional(),
    yieldSource: z.string(),
    yieldType: z.enum(YIELD_TYPE_VALUES),
  })
  .strict();

export const LaunchMilestoneSchema = z
  .object({
    date: FuzzyDateSchema,
    type: z.enum(LAUNCH_MILESTONE_TYPE_VALUES),
    title: z.string(),
    description: z.string().optional(),
    sourceUrl: HttpUrlSchema.optional(),
  })
  .strict();

export const DateHistoryEntrySchema = z
  .object({
    date: FuzzyDateSchema,
    setOn: StrictIsoDateSchema,
  })
  .strict();

export const FeaturedContentSchema = z
  .object({
    type: z.enum(FEATURED_CONTENT_TYPE_VALUES),
    url: HttpUrlSchema,
    title: z.string(),
    description: z.string().optional(),
    image: LocalPathOrHttpUrlSchema.optional(),
    source: z.string().optional(),
  })
  .strict();
export type ContractDeployment = z.output<typeof ContractDeploymentSchema>;
export type DependencyWeight = z.output<typeof DependencyWeightSchema>;
export type ReserveReview = z.output<typeof ReserveReviewSchema>;
export type ReserveNonLinkReview = NonNullable<ReserveReview["nonLinkDispositions"]>[number];
export type CustodyProfile = z.output<typeof CustodyProfileSchema>;
export type CustodyProviderReview = CustodyProfile["providers"][number];
export type DependencyReview = z.output<typeof DependencyReviewSchema>;
export type DependencyReviewRelationship = DependencyReview["relationships"][number];
export type CoinNotice = z.output<typeof CoinNoticeSchema>;
export type YieldConfig = z.output<typeof YieldConfigSchema>;
export type LaunchMilestone = z.output<typeof LaunchMilestoneSchema>;
export type DateHistoryEntry = z.output<typeof DateHistoryEntrySchema>;
export type FeaturedContent = z.output<typeof FeaturedContentSchema>;

export const StablecoinMetaEnumSchemas = {
  collateralQuality: CollateralQualitySchema,
  custodyModel: CustodyModelSchema,
  governanceQuality: GovernanceQualitySchema,
  oracleRiskTier: OracleRiskTierSchema,
  bridgeRouteRiskTier: BridgeRouteRiskTierSchema,
  infrastructures: z.array(z.enum(INFRASTRUCTURE_VALUES)),
  variantKind: z.enum(VARIANT_KIND_VALUES),
  wrapperOperator: z.enum(WRAPPER_OPERATOR_VALUES),
  launchPhase: z.enum(LAUNCH_PHASE_VALUES),
  marketAvailability: z.enum(MARKET_AVAILABILITY_VALUES),
  priceBasis: z.enum(STABLECOIN_PRICE_BASIS_VALUES),
  exitMechanism: z.enum(STABLECOIN_EXIT_MECHANISM_VALUES),
  status: z.enum(STABLECOIN_STATUS_VALUES),
  mechanismArchetype: z.enum(MECHANISM_ARCHETYPE_VALUES),
} as const;
