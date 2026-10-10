import { z } from "zod";
import { DeploymentAmountEncodingSchema } from "./deployment-amounts";
import { CHAIN_META } from "./chain-identity";
import { ReserveReportCoverageSchema, ReserveObservationEnvelopeSchema } from "./safety-score-v9-reserve-scope";
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
import { issue, StrictIsoDateSchema } from "./safety-schema-primitives";

// Pure scopes let bundlers omit unused schema graphs, including nested Zod
// constructor arguments; annotating only the outer call leaves those allocated.

const ContractDecimalsSchema = /* @__PURE__ */ (() => z.number().finite().int().min(0).max(255))();
const DependencyWeightNumberSchema = /* @__PURE__ */ (() => z.number().finite().positive().max(1))();
export const BlacklistabilityReviewStatusSchema = /* @__PURE__ */ (() => z.union([
  z.boolean(),
  z.literal("possible"),
  z.literal("inherited"),
]))();
export const PositiveIntegerSchema = /* @__PURE__ */ (() => z.number().finite().int().positive())();

export const ReviewDateSchema = StrictIsoDateSchema;

// Shape only; canonical-form admission uses the single normalizer in
// `shared/types/deployment-id.ts`. `validateMintBridgeOwnership()` raises
// `non-normalized-deployment-ref` for an id that parses but is not already
// normalized, and it runs in the merged catalog schema, `check:stablecoin-data`,
// and the V9 compiler defence. Keep these admission checks rather than adding
// a second normalization authority here.
export const DeploymentIdSchema = /* @__PURE__ */ (() => z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*:\S+$/, "Expected a chain:contractAddress deployment ID"))();
export const DeploymentRefsSchema = /* @__PURE__ */ (() => z
  .array(DeploymentIdSchema)
  .min(1)
  .refine((refs) => new Set(refs).size === refs.length, {
    message: "deploymentRefs must be unique",
  }))();

export const FuzzyDateSchema = /* @__PURE__ */ (() => z.string().refine(
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
))();

const LocalPathOrHttpUrlSchema = /* @__PURE__ */ (() => z.union([
  HttpUrlSchema,
  z.string().regex(/^\/[A-Za-z0-9][A-Za-z0-9/_\-.]*$/, "Expected a local absolute asset path"),
]))();

/**
 * Source coin files omit the four modal members below; the schema supplies them.
 * `backing` and `governance` have no dominant value and stay required. Parsed
 * output is always the full flag set, so every generated aggregate and runtime
 * consumer still sees explicit values.
 */
export const StablecoinFlagsSchema = /* @__PURE__ */ (() => z
  .object({
    backing: z.enum(BACKING_TYPE_VALUES),
    pegCurrency: z.enum(PEG_CURRENCY_VALUES).default("USD"),
    governance: z.enum(GOVERNANCE_TYPE_VALUES),
    yieldBearing: z.boolean().default(false),
    rwa: z.boolean().default(false),
    navToken: z.boolean().default(false),
  })
  .strict())();

export const StablecoinLinkSchema = /* @__PURE__ */ (() => z
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
  .strict())();

export const MechanismArchetypeReviewSchema = /* @__PURE__ */ (() => z
  .object({
    disposition: z.enum(MECHANISM_ARCHETYPE_REVIEW_DISPOSITION_VALUES),
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    rationale: z.string().min(12),
    sources: z.array(StablecoinLinkSchema).min(1),
  })
  .strict())();

export const ParentBackingInheritanceSchema = /* @__PURE__ */ (() => z
  .object({
    state: z.literal("withheld"),
    reason: z.literal("mixed-strategy-without-measured-parent-claim"),
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    sources: z.array(StablecoinLinkSchema).min(1),
  })
  .strict())();

export type ParentBackingInheritance = z.output<typeof ParentBackingInheritanceSchema>;

export const ProofOfReservesSchema = /* @__PURE__ */ (() => z
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
        // A signed/as-of date is a conservative publication bound, never a later inferred date.
        periodEnd: StrictIsoDateSchema.optional(),
        publishedAt: StrictIsoDateSchema.optional(),
        publishedAtBasis: z.enum(["explicit", "signed-date-standin"]).optional(),
        reviewReference: z
          .object({
            date: StrictIsoDateSchema,
            reviewedAt: ReviewDateSchema,
            dateKind: z.literal("unspecified"),
          })
          .strict()
          .optional(),
        assuranceMethod: z.enum(PROOF_ASSURANCE_METHOD_VALUES),
        scope: z.enum(PROOF_ASSURANCE_SCOPE_VALUES),
        liabilityReconciliation: z.enum(LIABILITY_RECONCILIATION_VALUES),
        coverage: ReserveReportCoverageSchema.optional(),
        reviewer: z.string().min(1),
        confidence: z.enum(RESEARCH_REVIEW_CONFIDENCE_VALUES),
        sources: z.array(StablecoinLinkSchema).min(1),
      })
      .strict()
      .superRefine((report, ctx) => {
        if (report.periodEnd == null && report.publishedAt == null && report.reviewReference == null) {
          issue(ctx, undefined, "latestReport requires a sourced date or an explicitly uncertain review reference");
        }
        if (report.publishedAtBasis != null && report.publishedAt == null) {
          issue(ctx, ["publishedAtBasis"], "latestReport publishedAtBasis requires publishedAt");
        }
        if (report.publishedAt != null && report.periodEnd != null && report.publishedAt < report.periodEnd) {
          issue(ctx, ["publishedAt"], "latestReport publishedAt cannot precede periodEnd");
        }
        if (
          report.scope === "assets-and-liabilities" &&
          (report.liabilityReconciliation === "none" || report.liabilityReconciliation === "unknown")
        ) {
          issue(ctx, ["liabilityReconciliation"], "assets-and-liabilities scope requires full or partial liability reconciliation");
        }
      })
      .optional(),
  })
  .strict())();

export type StablecoinFlags = z.infer<typeof StablecoinFlagsSchema>;
export type StablecoinLink = z.infer<typeof StablecoinLinkSchema>;
export type MechanismArchetypeReview = z.infer<typeof MechanismArchetypeReviewSchema>;
export type ProofOfReserves = z.infer<typeof ProofOfReservesSchema>;
export type ProofOfReservesLatestReport = NonNullable<ProofOfReserves["latestReport"]>;
/** Case-sensitive Cosmos bank identity, not a token contract or native gas. */
export const NativeBankDenomSchema = /* @__PURE__ */ (() => z.string().min(3).max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9/:._-]*$/)
  .refine(value => !value.startsWith("0x"), "Native bank denoms cannot be EVM addresses"))();
export const ContractDeploymentSchema = /* @__PURE__ */ (() => z.union([
  z.object({
    kind: z.literal("contract").optional(),
    chain: z.string(),
    address: z.string(),
    decimals: ContractDecimalsSchema.nullable(),
    amountEncoding: DeploymentAmountEncodingSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("native-denom"),
    chain: z.string().refine(chain => CHAIN_META[chain]?.nativeDenomRail !== undefined, "Chain has no registered native denom rail"),
    address: NativeBankDenomSchema,
    // Identity may be known before the denomination's display exponent is.
    // Quantitative consumers still require a positively verified fixed scale.
    decimals: ContractDecimalsSchema.nullable(),
    amountEncoding: DeploymentAmountEncodingSchema.optional(),
  }).strict(),
]).superRefine((deployment, ctx) => {
    const issued = deployment.amountEncoding?.kind === "xrpl-issued-currency";
    if (issued ? deployment.chain !== "xrpl" || deployment.decimals !== null : deployment.kind !== "native-denom" && deployment.decimals === null) {
      issue(ctx, undefined, "Null decimals require an explicit native bank denom or native XRPL issued amount");
    }
    if (deployment.chain === "xrpl" && deployment.amountEncoding?.kind === "fixed-decimal") {
      issue(ctx, undefined, "XRPL issued deployments cannot claim fixed decimals");
    }
  }))();

export const DependencyWeightSchema = /* @__PURE__ */ (() => z
  .object({
    id: z.string(),
    weight: DependencyWeightNumberSchema,
    type: z.enum(DEPENDENCY_TYPE_VALUES).optional(),
  })
  .strict())();

export const ReserveReviewSchema = /* @__PURE__ */ (() => z
  .object({
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    confidence: z.enum(RESEARCH_REVIEW_CONFIDENCE_VALUES),
    sources: z.array(StablecoinLinkSchema).min(1),
    rationale: z.string().min(1),
    compositionBasis: z.string().min(1),
    compositionAsOf: StrictIsoDateSchema.optional(),
    /** Explicit adapter ownership; omission retains the curated/report date contract. */
    compositionSource: z.literal("live-adapter").optional(),
    scope: z.enum(RESERVE_REVIEW_SCOPE_VALUES),
    observations: z.array(ReserveObservationEnvelopeSchema).optional(),
    reportScopeId: z.string().min(1).optional(),
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
  .strict())();

export const CustodyProfileSchema = /* @__PURE__ */ (() => z
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
      issue(ctx, ["providers"], "custody provider shares cannot exceed 100%");
    }
    if (profile.knownUnknownExposurePct != null && knownShares + profile.knownUnknownExposurePct > 100.5) {
      issue(ctx, ["knownUnknownExposurePct"], "custody provider shares plus known unknown exposure cannot exceed 100%");
    }
  }))();

export const DependencyReviewSchema = /* @__PURE__ */ (() => z
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
  .strict())();

export const CoinNoticeSchema = /* @__PURE__ */ (() => z
  .object({
    type: z.enum(COIN_NOTICE_TYPE_VALUES),
    title: z.string(),
    message: z.string(),
  })
  .strict())();

export const YieldConfigSchema = /* @__PURE__ */ (() => z
  .object({
    yieldSource: z.string(),
    yieldType: z.enum(YIELD_TYPE_VALUES),
  })
  .strict())();

export const LaunchMilestoneSchema = /* @__PURE__ */ (() => z
  .object({
    date: FuzzyDateSchema,
    type: z.enum(LAUNCH_MILESTONE_TYPE_VALUES),
    title: z.string(),
    description: z.string().optional(),
    sourceUrl: HttpUrlSchema.optional(),
  })
  .strict())();

export const DateHistoryEntrySchema = /* @__PURE__ */ (() => z
  .object({
    date: FuzzyDateSchema,
    setOn: StrictIsoDateSchema,
  })
  .strict())();

export const FeaturedContentSchema = /* @__PURE__ */ (() => z
  .object({
    type: z.enum(FEATURED_CONTENT_TYPE_VALUES),
    url: HttpUrlSchema,
    title: z.string(),
    description: z.string().optional(),
    image: LocalPathOrHttpUrlSchema.optional(),
    source: z.string().optional(),
  })
  .strict())();
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
