import { z } from "zod";
import { BluechipGradeSchema, YIELD_TYPE_VALUES } from "../../types/core";
import { isRecord } from "../type-guards";
import { canonicalizeForSid } from "./canonicalize";
import { normalizeSelectorCanonicalSources, normalizeSelectorInput, normalizeSelectorSnapshot } from "./snapshot-normalize";
import { sha256Hex } from "../sha256";
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
  type SelectorInput,
  type SelectorOutput,
  type SelectorCanonicalSourceEvidence,
} from "./types";

export const SELECTOR_SNAPSHOT_SID_PATTERN = /^[0-9a-f]{32}$/;
export const SELECTOR_SNAPSHOT_MAX_PAYLOAD_BYTES = 100 * 1024;
export const SELECTOR_SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;
// Unauthenticated POSTs get a bounded unread TTL; the first successful read
// extends the snapshot to the full retention TTL. Caps the storage blast
// radius of write spam without weakening retention for links actually shared.
export const SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS = 60 * 60 * 24 * 90;

const MAX_JSON_DEPTH = 12;

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
const OutputShapeSchema = z.object({
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

export type SelectorSnapshotValidationError = "unsafe" | "shape";

export type SelectorSnapshotValidationResult =
  | { ok: true; snapshot: SelectorOutput }
  | { ok: false; error: SelectorSnapshotValidationError };

export type SelectorSnapshotInputValidationResult =
  | { ok: true; input: SelectorInput }
  | { ok: false; error: SelectorSnapshotValidationError };

export function isSelectorSnapshotSid(value: string): boolean {
  return SELECTOR_SNAPSHOT_SID_PATTERN.test(value);
}

export function isSelectorSnapshotStructurallySafe(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) {
    return value.every((item) => isSelectorSnapshotStructurallySafe(item, depth + 1));
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return false;
    }
    if (!isSelectorSnapshotStructurallySafe((value as Record<string, unknown>)[key], depth + 1)) {
      return false;
    }
  }
  return true;
}

export function stripDebugFromSelectorSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const { debug: _debug, ...snapshot } = value;
  return snapshot;
}

export function validateSelectorSnapshotInput(value: unknown): SelectorSnapshotInputValidationResult {
  if (!isSelectorSnapshotStructurallySafe(value)) {
    return { ok: false, error: "unsafe" };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "shape" };
  }
  const candidate = isRecord(value.input) ? value.input : value;
  const parsed = SelectorInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: "shape" };
  }
  return { ok: true, input: normalizeSelectorInput(candidate as unknown as SelectorInput) };
}

export function validateSelectorSnapshot(value: unknown): SelectorSnapshotValidationResult {
  if (!isSelectorSnapshotStructurallySafe(value)) {
    return { ok: false, error: "unsafe" };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "shape" };
  }
  const snapshot = stripDebugFromSelectorSnapshot(value);
  if (!isSelectorOutputShape(snapshot)) {
    return { ok: false, error: "shape" };
  }
  const normalized = normalizeSelectorSnapshot(snapshot);
  return normalized
    ? { ok: true, snapshot: normalized }
    : { ok: false, error: "shape" };
}

function attachVerifiedSnapshotBinding(
  snapshot: SelectorOutput,
  canonicalSources?: SelectorCanonicalSourceEvidence[],
): SelectorOutput {
  return {
    ...snapshot,
    provenance: "pharos-verified",
    snapshotSchemaVersion: 3,
    verification: {
      kind: SELECTOR_SNAPSHOT_VERIFICATION_KIND,
      datasetHash: snapshot.datasetHash,
      engineVersion: snapshot.engineVersion,
      ...(canonicalSources === undefined ? {} : { canonicalSources }),
    },
  };
}

export function createVerifiedSelectorSnapshot(
  output: SelectorOutput,
  canonicalSources?: SelectorCanonicalSourceEvidence[],
): SelectorOutput {
  const validation = validateSelectorSnapshot(output);
  if (!validation.ok) {
    throw new Error("Server-recomputed selector output failed snapshot validation");
  }
  const evidence = canonicalSources === undefined ? undefined : normalizeSelectorCanonicalSources(canonicalSources);
  if (evidence === null) throw new Error("Server-fetched selector source evidence failed snapshot validation");
  return attachVerifiedSnapshotBinding(validation.snapshot, evidence);
}

export function validateVerifiedSelectorSnapshot(value: unknown): SelectorSnapshotValidationResult {
  if (!isSelectorSnapshotStructurallySafe(value) || !isRecord(value) || "debug" in value) {
    return { ok: false, error: "unsafe" };
  }
  if (!isSelectorOutputShape(value) || !isRecord(value.verification)) {
    return { ok: false, error: "shape" };
  }
  if (
    value.provenance !== "pharos-verified"
    || value.snapshotSchemaVersion !== 3
    || value.verification.kind !== SELECTOR_SNAPSHOT_VERIFICATION_KIND
    || value.verification.datasetHash !== value.datasetHash
    || value.verification.engineVersion !== value.engineVersion
  ) {
    return { ok: false, error: "shape" };
  }

  const normalized = normalizeSelectorSnapshot(value);
  if (!normalized) return { ok: false, error: "shape" };
  const evidence = value.verification.canonicalSources === undefined
    ? undefined
    : normalizeSelectorCanonicalSources(value.verification.canonicalSources);
  if (evidence === null) return { ok: false, error: "shape" };
  const verified = attachVerifiedSnapshotBinding(normalized, evidence);
  return canonicalizeForSid(value) === canonicalizeForSid(verified)
    ? { ok: true, snapshot: verified }
    : { ok: false, error: "shape" };
}

/**
 * Validates a snapshot returned by the trusted Pages Function boundary.
 * Verified-looking payloads must satisfy the exact verified contract; they
 * are never silently downgraded to the legacy client-unverified projection.
 */
export function validateSelectorSnapshotResponse(value: unknown): SelectorSnapshotValidationResult {
  if (
    isRecord(value)
    && (
      value.provenance === "pharos-verified"
      || value.snapshotSchemaVersion === 3
      || value.verification !== undefined
    )
  ) {
    return validateVerifiedSelectorSnapshot(value);
  }
  return validateSelectorSnapshot(value);
}

export function computeSelectorSnapshotSid(snapshot: unknown): string {
  return sha256Hex(canonicalizeForSid(snapshot)).slice(0, 32);
}

function isSelectorOutputShape(value: unknown): value is SelectorOutput {
  // Never feed a schema-stripped/defaulted clone into semantic normalization:
  // historical unknown fields and verified canonical equality have their own
  // projection rules, independent of structural admission.
  return OutputShapeSchema.safeParse(value).success;
}
