import { z } from "zod";
import { CAUSE_OF_DEATH_VALUES } from "./cause-of-death";
import { DetailProviderSchema } from "./core";
import { FullAuthoredReserveCompositionSchema } from "./reserves";
import { StrictIsoDateSchema } from "./safety-schema-primitives";
import { baseLiveReserveConfigSchema, LiveReserveInputSchemaByKind } from "./live-reserve-core";
import { LIVE_RESERVE_ADAPTER_KEYS } from "./live-reserve-adapter-declarations";
import { BridgeRouteRiskProfileSchema, MintAuthorityProfileSchema, OracleRiskProfileSchema } from "./stablecoin-meta-control-schemas";
import { BlacklistabilityReviewSchema, GeniusProfileSchema, JurisdictionSchema, MicaProfileSchema } from "./stablecoin-meta-compliance-schemas";
import {
  CoinNoticeSchema, ContractDeploymentSchema, CustodyProfileSchema, DateHistoryEntrySchema,
  DependencyReviewSchema, DependencyWeightSchema, FeaturedContentSchema, FuzzyDateSchema,
  LaunchMilestoneSchema, MechanismArchetypeReviewSchema, ParentBackingInheritanceSchema,
  ProofOfReservesSchema, ReserveReviewSchema, StablecoinFlagsSchema, StablecoinIdentifiersSchema, StablecoinLinkSchema,
  StablecoinMetaEnumSchemas, YieldConfigSchema,
} from "./stablecoin-meta-primitives";

// Adapter-specific inputs, params and policy are admitted by the lib schema.
const LiveReserveInputSchema = /* @__PURE__ */ (() => z.union(Object.values(LiveReserveInputSchemaByKind)))();
const LiveReservesConfigStructuralSchema = /* @__PURE__ */ (() => baseLiveReserveConfigSchema.extend({
  adapter: z.enum(LIVE_RESERVE_ADAPTER_KEYS),
  inputs: z.object({
    primary: LiveReserveInputSchema,
    fallbacks: z.array(LiveReserveInputSchema).optional(),
  }).strict(),
  params: z.record(z.string(), z.unknown()).optional(),
}))();

export const StablecoinObituarySchema = /* @__PURE__ */ (() => z.object({
  /** Cemetery cause-of-death vocabulary shared with DeadStablecoin. */
  causeOfDeath: z.enum(CAUSE_OF_DEATH_VALUES),
  /** YYYY-MM or YYYY-MM-DD; canonical cemetery admission stays in lib. */
  deathDate: z.string(),
  /** UTC cemetery entry date when it differs from frozenAt. */
  recordedAt: StrictIsoDateSchema.optional(),
  /** Headline shown in the detail banner and cemetery cards and register. */
  epitaph: z.string().min(1),
  /** Full obituary paragraph, collapsible in the detail banner. */
  obituary: z.string().min(1),
  /** Computed at freeze time from MAX(circulating_usd) over preserved history. */
  peakMcap: z.number().positive().optional(),
  sourceUrl: z.string().url(),
  sourceLabel: z.string().min(1),
}))();

export const StablecoinListingStatusReviewSchema = /* @__PURE__ */ (() => z.object({
  /** Date on which the lifecycle decision took effect. */
  changedAt: StrictIsoDateSchema,
  /** Concise public explanation for the quarantine or delisting. */
  reason: z.string().trim().min(1).max(280),
  /** Required follow-up date for reversible quarantines. */
  reviewBy: StrictIsoDateSchema.optional(),
  /** Primary evidence for an out-of-scope decision or runtime hold. */
  source: StablecoinLinkSchema.optional(),
}).strict())();

export const StablecoinMetaStructuralSchema = /* @__PURE__ */ (() => z.object({
  id: z.string(),
  llamaId: z.string().optional(),
  detailProvider: DetailProviderSchema.optional(),
  marketAvailability: StablecoinMetaEnumSchemas.marketAvailability.optional(),
  priceBasis: StablecoinMetaEnumSchemas.priceBasis.optional(),
  exitMechanism: StablecoinMetaEnumSchemas.exitMechanism.optional(),
  name: z.string(),
  symbol: z.string(),
  /** Searched issuer short name for profile titles; set only where `name` omits it, repeats the symbol, or is too long. */
  brand: z.string().trim().min(1).max(20).optional(),
  oneLiner: z.string().max(160).optional(),
  flags: StablecoinFlagsSchema,
  pegReferenceId: z.string().optional(),
  collateral: z.string().optional(),
  pegMechanism: z.string().optional(),
  mechanismArchetype: StablecoinMetaEnumSchemas.mechanismArchetype.optional(),
  mechanismArchetypeReview: MechanismArchetypeReviewSchema.optional(),
  /** Current mechanism boundary; fuzzy dates use conservative range-end policy. */
  implementationLaunchDate: FuzzyDateSchema.optional(),
  commodityOunces: z.number().finite().positive().optional(),
  geckoId: z.string().optional(),
  cmcSlug: z.string().optional(),
  protocolSlug: z.string().optional(),
  identifiers: StablecoinIdentifiersSchema.optional(),
  proofOfReserves: ProofOfReservesSchema.optional(),
  links: z.array(StablecoinLinkSchema).optional(),
  jurisdiction: JurisdictionSchema.optional(),
  mica: MicaProfileSchema.optional(),
  genius: GeniusProfileSchema.optional(),
  mintAuthority: MintAuthorityProfileSchema.optional(),
  // The deployment schema owns token-contract versus native bank-denom identity.
  contracts: z.array(ContractDeploymentSchema).optional(),
  tradedContracts: z.array(ContractDeploymentSchema).optional(),
  dependencies: z.array(DependencyWeightSchema).optional(),
  dependencyReview: DependencyReviewSchema.optional(),
  blacklistabilityReview: BlacklistabilityReviewSchema.optional(),
  collateralQuality: StablecoinMetaEnumSchemas.collateralQuality.optional(),
  custodyModel: StablecoinMetaEnumSchemas.custodyModel.optional(),
  governanceQuality: StablecoinMetaEnumSchemas.governanceQuality.optional(),
  oracleRisk: OracleRiskProfileSchema.optional(),
  bridgeRouteRisk: BridgeRouteRiskProfileSchema.optional(),
  infrastructures: StablecoinMetaEnumSchemas.infrastructures.optional(),
  variantOf: z.string().optional(),
  variantKind: StablecoinMetaEnumSchemas.variantKind.optional(),
  /** Required for risk-absorption variants to establish wrapper ownership. */
  wrapperOperator: StablecoinMetaEnumSchemas.wrapperOperator.optional(),
  /** Reviewed adverse inheritance boundary; retains the serial parent and peg. */
  parentBackingInheritance: ParentBackingInheritanceSchema.optional(),
  archetypeOverride: z
    .boolean()
    .describe("When true, mechanismArchetype is an intentional departure from the parent's archetype.")
    .optional(),
  reserves: FullAuthoredReserveCompositionSchema.optional(),
  reserveReview: ReserveReviewSchema.optional(),
  custodyProfile: CustodyProfileSchema.optional(),
  liveReservesConfig: LiveReservesConfigStructuralSchema.optional(),
  notices: z.array(CoinNoticeSchema).optional(),
  yieldConfig: YieldConfigSchema.optional(),
  status: StablecoinMetaEnumSchemas.status.optional(),
  /** Required for quarantined and delisted assets; preserved on detail pages. */
  listingStatusReview: StablecoinListingStatusReviewSchema.optional(),
  /** Issuer's public wind-down or termination announcement date for this token. */
  windDownAnnouncedAt: StrictIsoDateSchema.optional(),
  /** Public source for that wind-down or termination announcement. */
  windDownSourceUrl: z.string().url().optional(),
  /** Required when status is frozen. */
  frozenAt: StrictIsoDateSchema.optional(),
  /** Required when frozen; content and recorded supply remain authored evidence. */
  obituary: StablecoinObituarySchema.optional(),
  launchDate: FuzzyDateSchema.optional(),
  /** Reviewed lower bound for depeg-event coverage and the PegScore denominator. */
  pegScoreCoverage: z.object({
    startDate: StrictIsoDateSchema,
    basis: z.literal("audited-replay-and-live"),
    reviewedAt: StrictIsoDateSchema,
    replayRunId: z.string().trim().min(1).optional(),
    notes: z.string().trim().min(1),
  }).strict().optional(),
  announcedDate: FuzzyDateSchema.optional(),
  expectedLaunchDate: FuzzyDateSchema.optional(),
  launchPhase: StablecoinMetaEnumSchemas.launchPhase.optional(),
  launchPhaseDetail: z.string().optional(),
  featuredContent: z.array(FeaturedContentSchema).optional(),
  milestones: z.array(LaunchMilestoneSchema).optional(),
  dateHistory: z.array(DateHistoryEntrySchema).optional(),
}).strict())();

export type StablecoinMeta = z.output<typeof StablecoinMetaStructuralSchema>;
export type StablecoinObituary = z.output<typeof StablecoinObituarySchema>;
export type StablecoinListingStatusReview = z.output<typeof StablecoinListingStatusReviewSchema>;
