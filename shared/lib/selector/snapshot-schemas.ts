import { z } from "zod";
import { BluechipGradeSchema, YIELD_TYPE_VALUES } from "../../types/core";
import {
  BASE_CONFIDENCE_REASON_KEYS,
  COMPOSABILITY_VALUES,
  CONTEXT_KEYS,
  CUSTODY_OK_VALUES,
  DECENTRALIZATION_VALUES,
  DEPEG_TOLERANCE_VALUES,
  EXCLUSION_REASONS,
  EXIT_SPEED_VALUES,
  HORIZON_VALUES,
  LOWEST_SUB_DIMENSION_KEYS,
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  SELECTOR_PROFILES,
  SELECTOR_SNAPSHOT_VERIFICATION_KIND,
  TRADING_VENUE_VALUES,
  TREASURY_VENUE_VALUES,
  WEIGHT_KEYS,
  WHY_KEYS,
  YIELD_VENUE_VALUES,
  SelectorCanonicalSourceEvidenceSchema,
} from "./vocabulary";

const NonEmptyStringSchema = z.string().max(256).refine((value) => value.trim().length > 0);
const PercentSchema = z.number().min(0).max(100);
const NonNegativeSchema = z.number().min(0);
// z.int() also imposes safe-integer bounds, unlike the retained wire contract.
const CountSchema = NonNegativeSchema.refine(Number.isInteger);
const StringArraySchema = z.array(z.string().max(128)).max(64);
const WeightKeySchema = z.enum(WEIGHT_KEYS);
const ExclusionReasonSchema = z.enum(EXCLUSION_REASONS);
const SeveritySchema = z.enum(["info", "soft", "hard"]);
const VenueSchema = z.enum([...TREASURY_VENUE_VALUES, ...YIELD_VENUE_VALUES, ...TRADING_VENUE_VALUES]);
const VENUES_BY_PROFILE = {
  treasury: TREASURY_VENUE_VALUES,
  yield: YIELD_VENUE_VALUES,
  trading: TRADING_VENUE_VALUES,
};

export const SelectorInputSchema = z.object({
  profile: z.enum(SELECTOR_PROFILES),
  pegCurrency: z.enum(SELECTOR_ELIGIBLE_PEG_CURRENCIES),
  horizon: z.enum(HORIZON_VALUES),
  depegTolerance: z.enum(DEPEG_TOLERANCE_VALUES),
  composability: z.enum(COMPOSABILITY_VALUES),
  exitSpeed: z.enum(EXIT_SPEED_VALUES),
  /** Optional on historical snapshots; preserve the wizard's specific rail. */
  venuePreferences: z.array(VenueSchema).readonly().optional(),
  minApy: NonNegativeSchema.nullable(),
  yieldNativeOnly: z.boolean(),
  decentralization: z.enum(DECENTRALIZATION_VALUES),
  custodyOk: z.enum(CUSTODY_OK_VALUES),
}).refine(({ profile, venuePreferences }) => {
  const allowed: readonly string[] = VENUES_BY_PROFILE[profile];
  return venuePreferences === undefined
    || (venuePreferences.length <= allowed.length && venuePreferences.every((venue) => allowed.includes(venue)));
});

export const SelectorComponentSchema = z.object({
  key: WeightKeySchema,
  weight: PercentSchema,
  rawValue: z.number().nullable(),
  normalizedValue: PercentSchema.nullable(),
  contribution: PercentSchema,
  redistributed: z.boolean(),
});
export const LowestSubDimensionSchema = z.object({
  key: z.enum(LOWEST_SUB_DIMENSION_KEYS),
  score: PercentSchema,
  contextKeys: z.array(z.enum(CONTEXT_KEYS)).max(CONTEXT_KEYS.length),
});
export const RecommendedSourceSchema = z.object({
  sourceKey: NonEmptyStringSchema.nullish(),
  protocol: NonEmptyStringSchema,
  chain: NonEmptyStringSchema,
  yieldType: z.enum(YIELD_TYPE_VALUES).nullish(),
  apy30d: z.number(),
  pharosYieldScore: PercentSchema.nullable(),
  sourceTvlUsd: NonNegativeSchema.nullish(),
  /** Unknown is not a measured neutral tier. */
  sourceRiskTier: z.enum(["low", "mid", "high"]).nullable(),
  // Older artifacts omit this field; the semantic projector also emits null.
  freshness: z.object({
    capturedAt: NonNegativeSchema,
    ageSeconds: NonNegativeSchema,
  }).nullable().default(null),
  selectionReason: NonEmptyStringSchema.nullish(),
});
export const SelectorChainHintsSchema = z.object({
  topByLiquidity: StringArraySchema.max(3),
  topByYield: StringArraySchema.max(1),
  primary: z.string().nullable(),
});
export const SelectorRankRobustnessSchema = z.object({
  label: z.enum(["clear-margin", "crowded-field", "narrow-margin", "concentration-adjusted"]),
  scoreMargin: PercentSchema.nullable(),
});
export const SelectorConfidenceReasonSchema = z.union([
  z.enum(BASE_CONFIDENCE_REASON_KEYS),
  z.templateLiteral(["missing-critical-", WeightKeySchema]),
]);
const RecommendationBaseSchema = z.object({
  id: NonEmptyStringSchema,
  symbol: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  score: PercentSchema,
  confidence: PercentSchema,
  confidenceReasons: z.array(SelectorConfidenceReasonSchema).optional(),
  components: z.array(SelectorComponentSchema).max(16),
  whyKeys: z.array(z.enum(WHY_KEYS)).max(4),
  whyText: NonEmptyStringSchema.optional(),
  watchText: NonEmptyStringSchema.optional(),
  lowestSubDimension: LowestSubDimensionSchema,
  chainHints: SelectorChainHintsSchema,
  rankRobustness: SelectorRankRobustnessSchema.optional(),
  relaxedReason: ExclusionReasonSchema.nullish(),
  isRecentListing: z.boolean(),
  bluechipGrade: BluechipGradeSchema.nullable(),
  safetyGrade: z.union([BluechipGradeSchema, z.literal("NR")]),
  supplyUsd: NonNegativeSchema,
  isBeta: z.literal(true),
});
export const TreasuryRecommendationSchema = RecommendationBaseSchema.extend({
  profile: z.literal("treasury"),
  recommendedSource: z.null(),
  perInputStaleness: z.null(),
});
export const YieldRecommendationSchema = RecommendationBaseSchema.extend({
  profile: z.literal("yield"),
  recommendedSource: RecommendedSourceSchema,
  perInputStaleness: z.null(),
});
export const TradingRecommendationSchema = RecommendationBaseSchema.extend({
  profile: z.literal("trading"),
  recommendedSource: z.null(),
  perInputStaleness: z.record(z.string(), NonNegativeSchema)
    .refine((value) => Object.keys(value).every((key) => ["pegSummary", "dexTvl", "dews"].includes(key))),
});
export const SelectorRecommendationSchema = z.discriminatedUnion("profile", [
  TreasuryRecommendationSchema, YieldRecommendationSchema, TradingRecommendationSchema,
]);
const LOWER_RANKED_REASONS: readonly string[] = [
  ...EXCLUSION_REASONS, ...WEIGHT_KEYS.map((key) => `weak-${key}`),
];
export const SelectorLowerRankedSchema = z.object({
  id: NonEmptyStringSchema,
  symbol: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  slot: z.enum(["A", "B"]),
  reasonKey: z.string().refine((key) => LOWER_RANKED_REASONS.includes(key)),
  verdictText: NonEmptyStringSchema.optional(),
  teachingText: NonEmptyStringSchema.optional(),
  failedComponent: z.string().refine((key) => (WEIGHT_KEYS as readonly string[]).includes(key)).nullable(),
  hypotheticalScore: PercentSchema.nullable(),
});
export const SkippedCoinSchema = z.object({
  id: NonEmptyStringSchema, symbol: NonEmptyStringSchema, missingSignals: StringArraySchema,
});
export const SelectorCoverageWarningsSchema = z.object({
  skippedForCoverageCount: CountSchema,
  skippedForCoverage: z.array(SkippedCoinSchema).max(410),
  sparse: z.boolean(),
  uneven: z.boolean(),
  newListingCount: CountSchema,
  redistributionCount: CountSchema,
});
export const MethodologyVersionsSchema = z.object({
  safetyScore: NonEmptyStringSchema,
  pegScoreAndDews: NonEmptyStringSchema,
  yieldIntelligence: NonEmptyStringSchema,
  bluechipAlignment: NonEmptyStringSchema,
  exclusionFilters: NonEmptyStringSchema,
});
export const SelectorExclusionSummaryItemSchema = z.object({
  reason: ExclusionReasonSchema, count: CountSchema, severity: SeveritySchema, sampleIds: StringArraySchema,
});
export const SelectorClosestSurvivorSchema = z.object({
  id: NonEmptyStringSchema,
  symbol: NonEmptyStringSchema,
  failingDimension: NonEmptyStringSchema,
  liveReading: NonEmptyStringSchema,
  reason: ExclusionReasonSchema,
  hypotheticalScore: PercentSchema.nullable(),
});
export const SelectorRelaxableConstraintSchema = z.object({
  key: z.enum(["depegTolerance", "venue", "exitSpeed"]),
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  reason: z.union([ExclusionReasonSchema, z.literal("input-strictness")]),
});
export const SelectorSnapshotVerificationSchema = z.object({
  kind: z.literal(SELECTOR_SNAPSHOT_VERIFICATION_KIND),
  datasetHash: z.string(),
  engineVersion: z.string(),
  canonicalSources: z.array(SelectorCanonicalSourceEvidenceSchema).optional(),
});
export const OutputShapeSchema = z.object({
  profile: z.enum(SELECTOR_PROFILES),
  input: SelectorInputSchema,
  universe: z.object({ active: CountSchema, surviving: CountSchema })
    .refine(({ active, surviving }) => surviving <= active),
  recommended: z.array(SelectorRecommendationSchema).max(3),
  lowerRanked: z.array(SelectorLowerRankedSchema).max(2),
  coverageWarnings: SelectorCoverageWarningsSchema,
  lowConfidence: z.boolean(),
  usedRelaxedFallback: z.boolean(),
  relaxedReasons: z.array(ExclusionReasonSchema).max(EXCLUSION_REASONS.length),
  exclusionSummary: z.array(SelectorExclusionSummaryItemSchema).max(410),
  closestSurvivors: z.array(SelectorClosestSurvivorSchema).max(3),
  relaxableConstraints: z.array(SelectorRelaxableConstraintSchema).max(3),
  timestamp: z.number(),
  engineVersion: NonEmptyStringSchema,
  methodologyVersions: MethodologyVersionsSchema,
  datasetHash: NonEmptyStringSchema,
}).refine((value) => value.input.profile === value.profile
  && value.recommended.every((recommendation) => recommendation.profile === value.profile));
// Metadata is not structural admission: legacy callers may supply any values,
// which the semantic projector discards. Verified replay checks exact bindings.
export const SelectorOutputSchema = OutputShapeSchema.safeExtend({
  provenance: z.enum(["client-unverified", "pharos-verified"]).optional(),
  snapshotSchemaVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  verification: SelectorSnapshotVerificationSchema.optional(),
});
