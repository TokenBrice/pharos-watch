// Frozen PR-B Pages readers from 49da34e7834e07c54c1de376c7f89cb1166d1b16 (origin/main at PR-D review).
// Test-only esbuild CJS bundle; zod remains external. Do not refresh with the new producer.
// Sources: shared/contracts/api-meta.ts, shared/lib/math.ts, shared/lib/mint-burn-coin-helpers.ts, shared/lib/mint-burn-gauge-bands.ts, shared/lib/mint-burn-signals.ts, shared/lib/mint-burn-valuation-display.ts, shared/lib/mint-burn-valuation.ts, shared/types/date-primitives.ts, shared/types/mint-burn-signals.ts, shared/types/mint-burn.ts, shared/types/safety-schema-primitives.ts, shared/types/safety-score-publication.ts
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// <stdin>
var stdin_exports = {};
__export(stdin_exports, {
  MintBurnFlowsResponseSchema: () => MintBurnFlowsResponseSchema,
  MintBurnPerCoinResponseSchema: () => MintBurnPerCoinResponseSchema,
  aggregateCoinFlows24h: () => aggregateCoinFlows24h,
  resolveCoinNetFlow: () => resolveCoinNetFlow,
  resolveNetDirection: () => resolveNetDirection
});
module.exports = __toCommonJS(stdin_exports);

// shared/types/mint-burn.ts
var import_zod4 = require("zod");

// shared/types/mint-burn-signals.ts
var NET_FLOW_DIRECTION_24H_VALUES = [
  "minting",
  "burning",
  "flat",
  "inactive"
];
var PRESSURE_SHIFT_STATE_VALUES = [
  "improving",
  "stable",
  "worsening",
  "nr"
];

// shared/types/safety-score-publication.ts
var import_zod2 = require("zod");

// shared/types/safety-schema-primitives.ts
var import_zod = require("zod");

// shared/types/date-primitives.ts
function isValidCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1) return false;
  const daysInMonth = month === 2 ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28 : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
  return day <= daysInMonth;
}
function isValidIsoDateOnly(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidCalendarDate(year, month, day);
}
function parseIsoDateOrUtcInstantSec(value) {
  if (typeof value !== "string") return NaN;
  if (isValidIsoDateOnly(value)) return Date.parse(`${value}T00:00:00.000Z`) / 1e3;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|\.\d{1,3}Z)$/.exec(value);
  if (!match || !isValidIsoDateOnly(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return NaN;
  return Date.parse(value) / 1e3;
}

// shared/types/safety-schema-primitives.ts
var SHA256_PATTERN = /^[a-f0-9]{64}$/u;
var BASE_INPUT_GENERATION_ID_PATTERN = /^report-cards-input:v1:[a-f0-9]{64}$/u;
var CanonicalTextSchema = import_zod.z.string().min(1).refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");
var CANONICAL_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/u;
var CanonicalKeySchema = CanonicalTextSchema.refine(
  (value) => CANONICAL_KEY_PATTERN.test(value),
  "Value must be a canonical lowercase identifier"
);
var CanonicalChainIdSchema = CanonicalTextSchema.refine(
  (value) => CANONICAL_KEY_PATTERN.test(value),
  "Chain ID must be a canonical lowercase identifier"
);
var Sha256Schema = import_zod.z.string().regex(SHA256_PATTERN);
var BaseInputGenerationIdSchema = import_zod.z.string().regex(BASE_INPUT_GENERATION_ID_PATTERN);
var UnixSecondsSchema = import_zod.z.number().int().nonnegative();
var FractionSchema = import_zod.z.number().finite().min(0).max(1);
var NonNegativeFiniteSchema = import_zod.z.number().finite().nonnegative();
var ScoreSchema = import_zod.z.number().finite().min(0).max(100);
var StrictIsoDateSchema = import_zod.z.string().refine(isValidIsoDateOnly, "Expected YYYY-MM-DD");
var StrictIsoDateOrUtcInstantSchema = import_zod.z.string().refine(
  (value) => Number.isFinite(parseIsoDateOrUtcInstantSec(value)),
  "Expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[.SSS]Z"
);

// shared/types/safety-score-publication.ts
var SafetyScoreIdentityBaseSchema = import_zod2.z.object({
  model: import_zod2.z.string(),
  schemaVersion: import_zod2.z.literal(1),
  methodologyVersion: import_zod2.z.string().trim().min(1),
  evaluationBuildDigest: Sha256Schema,
  baseInputGenerationId: BaseInputGenerationIdSchema,
  publicationGenerationId: import_zod2.z.string().trim().min(1)
}).strict();
var SafetyScoreV8PublicationIdentitySchema = SafetyScoreIdentityBaseSchema.extend({
  model: import_zod2.z.literal("v8")
});
var SafetyScoreV9InputIdentitySchema = SafetyScoreIdentityBaseSchema.extend({
  model: import_zod2.z.literal("v9-input")
});
var SafetyScoreV9PublicationIdentitySchema = SafetyScoreIdentityBaseSchema.extend({
  model: import_zod2.z.literal("v9"),
  policyId: import_zod2.z.string().trim().min(1),
  policyDigest: Sha256Schema
});
var SafetyScorePublicationIdentitySchema = import_zod2.z.discriminatedUnion("model", [
  SafetyScoreV8PublicationIdentitySchema,
  SafetyScoreV9PublicationIdentitySchema
]);

// shared/contracts/api-meta.ts
var import_zod3 = require("zod");
var FRESHNESS_STATUS_VALUES = ["fresh", "degraded", "stale"];
var FreshnessStatusSchema = import_zod3.z.enum(FRESHNESS_STATUS_VALUES);
var FreshnessAssessmentSchema = import_zod3.z.object({
  assessedAt: import_zod3.z.number(),
  freshBudgetSec: import_zod3.z.number().nonnegative(),
  degradedBudgetSec: import_zod3.z.number().nonnegative()
});
var ApiDependencyMetaSchema = import_zod3.z.object({
  updatedAt: import_zod3.z.number().nullable().optional(),
  ageSeconds: import_zod3.z.number().nullable().optional(),
  /** Independent consumer budget and accepted generation, not the parent response clock. */
  freshBudgetSec: import_zod3.z.number().finite().nonnegative().optional(),
  generationId: import_zod3.z.string().nullable().optional(),
  status: import_zod3.z.enum([...FRESHNESS_STATUS_VALUES, "unavailable"]),
  reason: import_zod3.z.string().nullish()
});
var ApiMetaSchema = FreshnessAssessmentSchema.partial().extend({
  updatedAt: import_zod3.z.number(),
  ageSeconds: import_zod3.z.number(),
  status: FreshnessStatusSchema,
  warning: import_zod3.z.string().nullish(),
  dependencies: import_zod3.z.record(import_zod3.z.string(), ApiDependencyMetaSchema).nullish()
});
var ApiMetaWarningOnlySchema = import_zod3.z.object({
  status: import_zod3.z.literal("degraded"),
  warning: import_zod3.z.string(),
  updatedAt: import_zod3.z.undefined().optional(),
  ageSeconds: import_zod3.z.undefined().optional(),
  dependencies: import_zod3.z.undefined().optional()
});
var ApiMetaUnavailableSchema = FreshnessAssessmentSchema.partial().extend({
  updatedAt: import_zod3.z.null(),
  ageSeconds: import_zod3.z.null(),
  status: import_zod3.z.enum(["stale", "unknown"]),
  reason: import_zod3.z.string(),
  warning: import_zod3.z.string().nullish(),
  dependencies: import_zod3.z.record(import_zod3.z.string(), ApiDependencyMetaSchema).nullish()
});
var ApiMetaEnvelopeSchema = import_zod3.z.union([
  ApiMetaSchema,
  ApiMetaWarningOnlySchema,
  ApiMetaUnavailableSchema
]);

// shared/types/mint-burn.ts
var SignedFlowIntensitySchema = import_zod4.z.number().min(-100).max(100);
var PressureShiftStateSchema = import_zod4.z.enum(PRESSURE_SHIFT_STATE_VALUES);
var NetFlowDirection24hSchema = import_zod4.z.enum(NET_FLOW_DIRECTION_24H_VALUES);
var MINT_BURN_VALUATION_COMPLETENESS_VALUES = ["complete", "partial", "unknown"];
var MintBurnValuationCompletenessSchema = import_zod4.z.enum(MINT_BURN_VALUATION_COMPLETENESS_VALUES);
var MintBurnValuationSchema = import_zod4.z.object({
  completeness: MintBurnValuationCompletenessSchema,
  mintCompleteness: MintBurnValuationCompletenessSchema,
  burnCompleteness: MintBurnValuationCompletenessSchema,
  /** Counted mints without a USD valuation, in hours whose coverage was recorded (a lower bound when `mintCompleteness` is `unknown`). */
  unpricedMintEventCount: import_zod4.z.number().int().nonnegative(),
  /** Counted effective burns without a USD valuation, in hours whose coverage was recorded. */
  unpricedBurnEventCount: import_zod4.z.number().int().nonnegative()
});
var MintBurnSignedNetBoundSchema = import_zod4.z.object({
  kind: import_zod4.z.enum(["lower", "upper"]),
  valueUsd: import_zod4.z.number().finite()
});
var MintBurnGaugeSchema = import_zod4.z.object({
  score: SignedFlowIntensitySchema.nullable(),
  band: import_zod4.z.string().nullable(),
  intensitySemantics: import_zod4.z.literal("signed-v2"),
  /** `null` when classification is unavailable or missing valuation can alter the conclusion. */
  flightToQuality: import_zod4.z.boolean().nullable(),
  flightIntensity: import_zod4.z.number().finite().nullable(),
  // The retired cache label is accepted for rolling/historical payload reads.
  classificationSource: import_zod4.z.enum(["safety-score-v9-publication", "report-card-cache", "unavailable"]).optional(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
  /** Machine-readable classification failure, independent of USD valuation gating. */
  classificationReason: import_zod4.z.string().nullable().optional(),
  trackedCoins: import_zod4.z.number().int().nonnegative(),
  /** Sum of observed tracked-chain supply; coins counted in `mcapUnavailableCoins` are excluded, not zeroed. */
  trackedMcapUsd: import_zod4.z.number().finite().nonnegative(),
  /**
   * Tracked coins whose supply weight was unavailable, excluded from the gauge weights and
   * `trackedMcapUsd`. Absent on payloads produced before the count existed (count unknown).
   */
  mcapUnavailableCoins: import_zod4.z.number().int().nonnegative().optional(),
  /**
   * Weighted coins whose valuation can alter `score`. Since mint-burn-flow v6.23 these are coins with
   * 24h activity and at least seven days of baseline history whose pressure is withheld because the 24h window is not `complete`
   * or the baseline is `partial`; `score` re-weights over the remaining coins, so any positive count
   * means it is not the full-cohort composite. Before v6.23 the count named partial inputs that
   * entered `score`. Absent on payloads produced before valuation completeness existed (unknown).
   */
  partialValuationInputs: import_zod4.z.number().int().nonnegative().optional(),
  /** Observed weight of the coins counted in `partialValuationInputs`. Absent before v6.23. */
  partialValuationMcapUsd: import_zod4.z.number().finite().nonnegative().optional(),
  /**
   * Observed weight of the coins whose pressure entered `score` (its re-weighting denominator).
   * With `partialValuationMcapUsd` it bounds the full-cohort score. Absent before v6.23.
   */
  scoredMcapUsd: import_zod4.z.number().finite().nonnegative().optional()
});
var MintBurnScopeSchema = import_zod4.z.object({
  chainIds: import_zod4.z.array(import_zod4.z.string()),
  label: import_zod4.z.string()
});
var MintBurnSyncSchema = import_zod4.z.object({
  lastSuccessfulSyncAt: import_zod4.z.number().nullable(),
  freshnessStatus: FreshnessStatusSchema,
  warning: import_zod4.z.string().nullable(),
  classificationWarning: import_zod4.z.string().nullable().optional(),
  criticalLaneHealthy: import_zod4.z.boolean()
});
var MintBurnCoverageStatusSchema = import_zod4.z.enum([
  "full",
  "partial-history",
  "lagging",
  "bootstrapping",
  "unknown",
  "disabled"
]);
var MintBurnCoinCoverageSchema = import_zod4.z.object({
  startBlock: import_zod4.z.number(),
  lastSyncedBlock: import_zod4.z.number().nullable(),
  lagBlocks: import_zod4.z.number().nullable(),
  historyStartAt: import_zod4.z.number().nullable(),
  has24hWindow: import_zod4.z.boolean(),
  has30dWindow: import_zod4.z.boolean(),
  has90dWindow: import_zod4.z.boolean(),
  isPartial: import_zod4.z.boolean(),
  adapterKinds: import_zod4.z.array(import_zod4.z.string()).optional(),
  startBlockSource: import_zod4.z.string().optional(),
  startBlockConfidence: import_zod4.z.enum(["high", "medium", "low"]).optional(),
  status: MintBurnCoverageStatusSchema
});
var MintBurnCoinValuationSchema = import_zod4.z.object({
  window24h: MintBurnValuationSchema,
  baseline: MintBurnValuationCompletenessSchema,
  netFlow7d: MintBurnValuationCompletenessSchema,
  netFlow30d: MintBurnValuationCompletenessSchema,
  netFlow90d: MintBurnValuationCompletenessSchema,
  /** One-sided bound on a withheld window net; `null` when none is proven. Absent before v6.25. */
  netFlow7dBound: MintBurnSignedNetBoundSchema.nullable().optional(),
  netFlow30dBound: MintBurnSignedNetBoundSchema.nullable().optional(),
  netFlow90dBound: MintBurnSignedNetBoundSchema.nullable().optional()
});
var MintBurnCoinFlowSchema = import_zod4.z.object({
  stablecoinId: import_zod4.z.string(),
  symbol: import_zod4.z.string(),
  pressureShiftScore: SignedFlowIntensitySchema.nullable(),
  pressureShiftState: PressureShiftStateSchema,
  /** `null` when missing valuation or scan evidence leaves the direction unproven. */
  netFlowDirection24h: NetFlowDirection24hSchema.nullable(),
  /** True: observed activity; false: proven quiet; null: activity is unknown. */
  has24hActivity: import_zod4.z.boolean().nullable(),
  baselineDailyNetUsd: import_zod4.z.number().nullable(),
  baselineDailyAbsUsd: import_zod4.z.number().nullable(),
  baselineDataDays: import_zod4.z.number().nullable(),
  /**
   * Observed tracked-chain supply weight the Bank Run Gauge applies to this coin (mint-burn-flow
   * v6.27). `null` when the weight is unavailable: the coin is excluded from the gauge and counted in
   * `gauge.mcapUnavailableCoins`, never weighted as zero. The coin moves `gauge.score` only when its
   * `pressureShiftScore` is non-null. Absent on payloads produced before the field existed.
   */
  gaugeWeightUsd: import_zod4.z.number().finite().nonnegative().nullable().optional(),
  /**
   * Signed nets are `null` when scan-window evidence is unavailable or valuation is `partial`
   * (a partial signed net is not a bound in either direction). An `unknown` valuation window
   * keeps its known-valuation net only when scan evidence admits it, labelled by `valuation`.
   */
  netFlow24hUsd: import_zod4.z.number().finite().nullable(),
  /** Known-valuation subtotals: lower bounds unless the matching `valuation` side is `complete`. */
  mintVolume24hUsd: import_zod4.z.number().finite().nonnegative(),
  burnVolume24hUsd: import_zod4.z.number().finite().nonnegative(),
  mintCount24h: import_zod4.z.number().int().nonnegative(),
  burnCount24h: import_zod4.z.number().int().nonnegative(),
  netFlow7dUsd: import_zod4.z.number().finite().nullable(),
  netFlow30dUsd: import_zod4.z.number().finite().nullable(),
  netFlow90dUsd: import_zod4.z.number().finite().nullable(),
  largestEvent24h: import_zod4.z.object({
    direction: import_zod4.z.enum(["mint", "burn"]),
    amountUsd: import_zod4.z.number(),
    txHash: import_zod4.z.string(),
    timestamp: import_zod4.z.number()
  }).nullable(),
  coverage: MintBurnCoinCoverageSchema.optional(),
  /** Absent on payloads produced before valuation completeness existed (unknown). */
  valuation: MintBurnCoinValuationSchema.optional()
});
var MintBurnHourlyBucketSchema = import_zod4.z.object({
  hourTs: import_zod4.z.number().int().nonnegative(),
  netFlowUsd: import_zod4.z.number().finite().nullable(),
  mintVolumeUsd: import_zod4.z.number().finite().nonnegative(),
  burnVolumeUsd: import_zod4.z.number().finite().nonnegative(),
  /** Absent on payloads produced before valuation completeness existed (unknown). */
  valuation: MintBurnValuationCompletenessSchema.optional()
});
var MintBurnAggregateChainSchema = import_zod4.z.object({
  chainId: import_zod4.z.string(),
  netFlow24hUsd: import_zod4.z.number().finite().nullable(),
  /** Absent on payloads produced before valuation completeness existed (unknown). */
  valuation: MintBurnValuationCompletenessSchema.optional()
});
var MintBurnHourlyWindowSchema = import_zod4.z.object({
  start: import_zod4.z.number().int().nonnegative(),
  end: import_zod4.z.number().int().nonnegative(),
  semantics: import_zod4.z.literal("closed-utc-hours")
});
var MintBurnFlowsResponseSchema = import_zod4.z.object({
  gauge: MintBurnGaugeSchema,
  coins: import_zod4.z.array(MintBurnCoinFlowSchema),
  chains: import_zod4.z.array(MintBurnAggregateChainSchema).optional(),
  hourly: import_zod4.z.array(MintBurnHourlyBucketSchema),
  updatedAt: import_zod4.z.number(),
  windowHours: import_zod4.z.number().int().positive().optional(),
  /** Exact [start,end) UTC boundaries; absent on pre-cutover historical payloads. */
  window: MintBurnHourlyWindowSchema.optional(),
  scope: MintBurnScopeSchema.optional(),
  sync: MintBurnSyncSchema.optional(),
  _meta: ApiMetaEnvelopeSchema.optional()
});
var MintBurnPerCoinChainSchema = import_zod4.z.object({
  chainId: import_zod4.z.string(),
  mintVolumeUsd: import_zod4.z.number().finite().nonnegative(),
  burnVolumeUsd: import_zod4.z.number().finite().nonnegative(),
  mintCount: import_zod4.z.number().int().nonnegative(),
  burnCount: import_zod4.z.number().int().nonnegative(),
  netFlowUsd: import_zod4.z.number().finite().nullable(),
  valuation: MintBurnValuationSchema.optional()
});
var MintBurnPerCoinResponseSchema = import_zod4.z.object({
  stablecoinId: import_zod4.z.string(),
  symbol: import_zod4.z.string(),
  mintVolumeUsd: import_zod4.z.number().finite().nonnegative(),
  burnVolumeUsd: import_zod4.z.number().finite().nonnegative(),
  netFlowUsd: import_zod4.z.number().finite().nullable(),
  mintCount: import_zod4.z.number().int().nonnegative(),
  burnCount: import_zod4.z.number().int().nonnegative(),
  chains: import_zod4.z.array(MintBurnPerCoinChainSchema),
  hourly: import_zod4.z.array(MintBurnHourlyBucketSchema),
  /** Qualifies the window totals. Absent on payloads produced before valuation completeness existed (unknown). */
  valuation: MintBurnValuationSchema.optional(),
  updatedAt: import_zod4.z.number(),
  windowHours: import_zod4.z.number().int().positive().optional(),
  window: MintBurnHourlyWindowSchema.optional(),
  scope: MintBurnScopeSchema.optional(),
  sync: MintBurnSyncSchema.optional(),
  _meta: ApiMetaEnvelopeSchema.optional()
});
var MintBurnFlowTypeSchema = import_zod4.z.enum(["standard", "atomic_roundtrip", "bridge_transfer", "protocol_internal"]);
var MintBurnEventSchema = import_zod4.z.object({
  id: import_zod4.z.string(),
  stablecoinId: import_zod4.z.string(),
  symbol: import_zod4.z.string(),
  chainId: import_zod4.z.string(),
  direction: import_zod4.z.enum(["mint", "burn"]),
  flowType: MintBurnFlowTypeSchema,
  burnType: import_zod4.z.enum(["effective_burn", "bridge_burn", "review_required"]).nullable(),
  burnReviewReason: import_zod4.z.string().nullable(),
  amount: import_zod4.z.number(),
  amountUsd: import_zod4.z.number().nullable(),
  priceUsed: import_zod4.z.number().nullable(),
  priceTimestamp: import_zod4.z.number().nullable(),
  priceSource: import_zod4.z.string().nullable(),
  counterparty: import_zod4.z.string().nullable(),
  txHash: import_zod4.z.string(),
  blockNumber: import_zod4.z.number(),
  timestamp: import_zod4.z.number(),
  explorerTxUrl: import_zod4.z.string()
});
var MintBurnEventsResponseSchema = import_zod4.z.object({
  events: import_zod4.z.array(MintBurnEventSchema),
  total: import_zod4.z.number()
});

// shared/lib/mint-burn-signals.ts
function getNetFlowDirection24h(input) {
  if (!input.has24hActivity) {
    return "inactive";
  }
  if (input.netFlow24hUsd > 0) {
    return "minting";
  }
  if (input.netFlow24hUsd < 0) {
    return "burning";
  }
  return "flat";
}

// shared/lib/mint-burn-valuation.ts
function combineMintBurnValuationCompleteness(...values) {
  if (values.includes("partial")) return "partial";
  if (values.includes("unknown")) return "unknown";
  return "complete";
}
function mintBurnSignedNetRange(knownNetUsd, valuation) {
  return {
    lowerUsd: valuation.burnCompleteness === "complete" ? knownNetUsd : Number.NEGATIVE_INFINITY,
    upperUsd: valuation.mintCompleteness === "complete" ? knownNetUsd : Number.POSITIVE_INFINITY
  };
}
function boundMintBurnSignedNetRange(range) {
  const lowerFinite = Number.isFinite(range.lowerUsd);
  if (lowerFinite === Number.isFinite(range.upperUsd)) return null;
  return lowerFinite ? { kind: "lower", valueUsd: range.lowerUsd } : { kind: "upper", valueUsd: range.upperUsd };
}
function mintBurnSignedNetBound(knownNetUsd, valuation) {
  return boundMintBurnSignedNetRange(mintBurnSignedNetRange(knownNetUsd, valuation));
}
function provenNetFlowDirection24h(input) {
  if (!input.has24hActivity) return "inactive";
  const { lowerUsd, upperUsd } = mintBurnSignedNetRange(input.knownNetUsd, input.valuation);
  if (lowerUsd === upperUsd) {
    return getNetFlowDirection24h({ netFlow24hUsd: input.knownNetUsd, has24hActivity: true });
  }
  if (lowerUsd > 0) return "minting";
  if (upperUsd < 0) return "burning";
  return null;
}
var UNKNOWN_VALUATION = {
  completeness: "unknown",
  mintCompleteness: "unknown",
  burnCompleteness: "unknown",
  unpricedMintEventCount: 0,
  unpricedBurnEventCount: 0
};
function resolveMintBurnValuation(valuation) {
  return valuation ?? UNKNOWN_VALUATION;
}
function resolveMintBurnValuationCompleteness(completeness) {
  return completeness ?? "unknown";
}

// shared/lib/mint-burn-valuation-display.ts
var MINT_BURN_COVERAGE_UNKNOWN_NOTE = "Coverage unknown: aggregated before valuation completeness was recorded";
var NET_UNAVAILABLE_NOTE = "Signed net unavailable: window evidence incomplete";
var PARTIAL_SUM_NOTE = "Partial valuation: a component has unpriced events; summed signed net unavailable";
var SUM_UNAVAILABLE_NOTE = "Summed signed net unavailable: a component net is unavailable";
function describeUnpricedEvents(counts) {
  return `${counts.unpricedMintEventCount} mint / ${counts.unpricedBurnEventCount} burn events unpriced`;
}
function describeMintBurnSignedNetBound(bound, reason) {
  return bound.kind === "lower" ? `Lower bound: ${reason}; unpriced mints can only raise the net` : `Upper bound: ${reason}; unpriced burns can only lower the net`;
}
function resolveMintBurnSignedNet(valueUsd, completeness, counts, bound) {
  const resolved = resolveMintBurnValuationCompleteness(completeness);
  if (resolved === "partial") {
    if (bound) {
      const reason = counts ? describeUnpricedEvents(counts) : "unpriced events in this window";
      return { valueUsd: null, completeness: resolved, note: describeMintBurnSignedNetBound(bound, reason), bound };
    }
    const note = counts ? `Partial valuation: ${describeUnpricedEvents(counts)}; signed net unavailable` : "Partial valuation: unpriced events in this window; signed net unavailable";
    return { valueUsd: null, completeness: resolved, note };
  }
  if (valueUsd == null) return { valueUsd: null, completeness: resolved, note: NET_UNAVAILABLE_NOTE };
  if (resolved === "unknown") return { valueUsd, completeness: resolved, note: MINT_BURN_COVERAGE_UNKNOWN_NOTE };
  return { valueUsd, completeness: resolved, note: null };
}
function sumMintBurnSignedNets(parts) {
  const completeness = combineMintBurnValuationCompleteness(...parts.map((part) => part.completeness));
  let total = 0;
  let lowerUsd = 0;
  let upperUsd = 0;
  let unavailable = false;
  for (const part of parts) {
    if (part.valueUsd != null) {
      total += part.valueUsd;
      lowerUsd += part.completeness === "unknown" ? Number.NEGATIVE_INFINITY : part.valueUsd;
      upperUsd += part.completeness === "unknown" ? Number.POSITIVE_INFINITY : part.valueUsd;
      continue;
    }
    unavailable = true;
    lowerUsd += part.bound?.kind === "lower" ? part.bound.valueUsd : Number.NEGATIVE_INFINITY;
    upperUsd += part.bound?.kind === "upper" ? part.bound.valueUsd : Number.POSITIVE_INFINITY;
  }
  if (unavailable) {
    const bound = completeness === "partial" ? boundMintBurnSignedNetRange({ lowerUsd, upperUsd }) : null;
    if (bound) {
      return { valueUsd: null, completeness, note: describeMintBurnSignedNetBound(bound, "a component has unpriced events"), bound };
    }
    return {
      valueUsd: null,
      completeness,
      note: completeness === "partial" ? PARTIAL_SUM_NOTE : SUM_UNAVAILABLE_NOTE
    };
  }
  return { valueUsd: total, completeness, note: completeness === "unknown" ? MINT_BURN_COVERAGE_UNKNOWN_NOTE : null };
}

// shared/lib/mint-burn-coin-helpers.ts
function inferHas24hActivity(coin) {
  if (coin.has24hActivity !== void 0) return coin.has24hActivity;
  return Boolean(
    coin.mintCount24h || coin.burnCount24h || coin.mintVolume24hUsd || coin.burnVolume24hUsd || coin.netFlow24hUsd
  );
}
function resolveCoinNetFlow(coin, window) {
  if (window === "24h" && coin.has24hActivity === null) {
    return {
      valueUsd: null,
      completeness: resolveMintBurnValuation(coin.valuation?.window24h).completeness,
      note: "24h scan coverage unknown; signed net unavailable"
    };
  }
  switch (window) {
    case "24h":
      return resolveMintBurnSignedNet(
        coin.netFlow24hUsd,
        coin.valuation?.window24h.completeness,
        coin.valuation?.window24h,
        coin.valuation ? mintBurnSignedNetBound(coin.netFlow24hUsd ?? coin.mintVolume24hUsd - coin.burnVolume24hUsd, coin.valuation.window24h) : null
      );
    // Longer windows publish their bound directly (absent on pre-v6.25 payloads).
    case "7d":
      return resolveMintBurnSignedNet(coin.netFlow7dUsd, coin.valuation?.netFlow7d, null, coin.valuation?.netFlow7dBound);
    case "30d":
      return resolveMintBurnSignedNet(coin.netFlow30dUsd, coin.valuation?.netFlow30d, null, coin.valuation?.netFlow30dBound);
    case "90d":
      return resolveMintBurnSignedNet(coin.netFlow90dUsd, coin.valuation?.netFlow90d, null, coin.valuation?.netFlow90dBound);
  }
}
function resolveNetDirection(coin) {
  const has24hActivity = inferHas24hActivity(coin);
  if (has24hActivity === null) return null;
  const valuation = resolveMintBurnValuation(coin.valuation?.window24h);
  if (valuation.completeness === "partial" && coin.netFlow24hUsd != null) {
    return provenNetFlowDirection24h({
      knownNetUsd: coin.netFlow24hUsd,
      has24hActivity,
      valuation
    });
  }
  if (coin.netFlowDirection24h !== void 0) return coin.netFlowDirection24h;
  if (coin.netFlow24hUsd == null) return null;
  return getNetFlowDirection24h({
    netFlow24hUsd: coin.netFlow24hUsd,
    has24hActivity
  });
}
function aggregateCoinFlows24h(coins) {
  let mintVolumeUsd = 0;
  let burnVolumeUsd = 0;
  let unpricedMintEventCount = 0;
  let unpricedBurnEventCount = 0;
  let knownNetUsd = 0;
  let has24hActivity = false;
  let activityUnknown = false;
  const mintSides = [];
  const burnSides = [];
  const nets = [];
  for (const coin of coins) {
    const valuation = resolveMintBurnValuation(coin.valuation?.window24h);
    mintVolumeUsd += coin.mintVolume24hUsd;
    burnVolumeUsd += coin.burnVolume24hUsd;
    unpricedMintEventCount += valuation.unpricedMintEventCount;
    unpricedBurnEventCount += valuation.unpricedBurnEventCount;
    mintSides.push(valuation.mintCompleteness);
    burnSides.push(valuation.burnCompleteness);
    nets.push(resolveCoinNetFlow(coin, "24h"));
    const coinKnownNetUsd = coin.netFlow24hUsd ?? (coin.has24hActivity !== null && valuation.completeness === "partial" ? coin.mintVolume24hUsd - coin.burnVolume24hUsd : null);
    knownNetUsd = knownNetUsd == null || coinKnownNetUsd == null ? null : knownNetUsd + coinKnownNetUsd;
    const activity = inferHas24hActivity(coin);
    if (activity === null) activityUnknown = true;
    if (activity) has24hActivity = true;
    else if (activity === null && has24hActivity === false) has24hActivity = null;
  }
  const summed = sumMintBurnSignedNets(nets);
  const mintCompleteness = combineMintBurnValuationCompleteness(...mintSides);
  const burnCompleteness = combineMintBurnValuationCompleteness(...burnSides);
  const bound = !activityUnknown && summed.valueUsd == null && summed.completeness === "partial" && knownNetUsd != null ? mintBurnSignedNetBound(knownNetUsd, { mintCompleteness, burnCompleteness }) : null;
  const net = bound ? {
    ...summed,
    bound,
    note: describeMintBurnSignedNetBound(bound, describeUnpricedEvents({ unpricedMintEventCount, unpricedBurnEventCount }))
  } : summed;
  let direction;
  if (activityUnknown) {
    direction = null;
  } else if (knownNetUsd != null && has24hActivity !== null) {
    direction = provenNetFlowDirection24h({
      knownNetUsd,
      has24hActivity,
      valuation: { mintCompleteness, burnCompleteness }
    });
  } else {
    direction = has24hActivity === false ? "inactive" : null;
  }
  return {
    mintVolumeUsd,
    burnVolumeUsd,
    mintCompleteness,
    burnCompleteness,
    unpricedMintEventCount,
    unpricedBurnEventCount,
    net,
    has24hActivity,
    direction
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MintBurnFlowsResponseSchema,
  MintBurnPerCoinResponseSchema,
  aggregateCoinFlows24h,
  resolveCoinNetFlow,
  resolveNetDirection
});
