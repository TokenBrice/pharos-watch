import { BluechipGradeSchema, YIELD_TYPE_VALUES } from "../../types/core";
import { isFiniteNumber, isRecord } from "../type-guards";
import { canonicalizeForSid } from "./canonicalize";
import { normalizeSelectorInput, normalizeSelectorSnapshot } from "./snapshot-normalize";
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
  type SelectorInput,
  type SelectorOutput,
} from "./types";

export const SELECTOR_SNAPSHOT_SID_PATTERN = /^[0-9a-f]{32}$/;
export const SELECTOR_SNAPSHOT_MAX_PAYLOAD_BYTES = 100 * 1024;
export const SELECTOR_SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;
// Unauthenticated POSTs get a bounded unread TTL; the first successful read
// extends the snapshot to the full retention TTL. Caps the storage blast
// radius of write spam without weakening retention for links actually shared.
export const SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS = 60 * 60 * 24 * 90;

const MAX_JSON_DEPTH = 12;

const SELECTOR_PROFILE_SET = new Set<string>(SELECTOR_PROFILES);
const SELECTOR_PEG_SET = new Set<string>(SELECTOR_ELIGIBLE_PEG_CURRENCIES);
const HORIZON_SET = new Set<string>(HORIZON_VALUES);
const DEPEG_TOLERANCE_SET = new Set<string>(DEPEG_TOLERANCE_VALUES);
const COMPOSABILITY_SET = new Set<string>(COMPOSABILITY_VALUES);
const EXIT_SPEED_SET = new Set<string>(EXIT_SPEED_VALUES);
const DECENTRALIZATION_SET = new Set<string>(DECENTRALIZATION_VALUES);
const CUSTODY_OK_SET = new Set<string>(CUSTODY_OK_VALUES);
const WEIGHT_KEY_SET = new Set<string>(WEIGHT_KEYS);
const WHY_KEY_SET = new Set<string>(WHY_KEYS);
const LOWEST_SUB_DIMENSION_SET = new Set<string>(LOWEST_SUB_DIMENSION_KEYS);
const CONTEXT_KEY_SET = new Set<string>(CONTEXT_KEYS);
const LOWER_RANKED_REASON_SET = new Set<string>([
  ...EXCLUSION_REASONS,
  ...WEIGHT_KEYS.map((key) => `weak-${key}`),
]);
const EXCLUSION_REASON_SET = new Set<string>(EXCLUSION_REASONS);
const SOURCE_RISK_TIERS = new Set(["low", "mid", "high"]);
const YIELD_TYPE_SET = new Set<string>(YIELD_TYPE_VALUES);
const PER_INPUT_STALENESS_KEYS = new Set(["pegSummary", "dexTvl", "dews"]);
const EXCLUSION_SEVERITIES = new Set(["info", "soft", "hard"]);
const RELAXABLE_CONSTRAINT_KEYS = new Set(["depegTolerance", "venue", "exitSpeed"]);
const VENUE_SETS_BY_PROFILE: Record<string, ReadonlySet<string>> = {
  treasury: new Set<string>(TREASURY_VENUE_VALUES),
  yield: new Set<string>(YIELD_VENUE_VALUES),
  trading: new Set<string>(TRADING_VENUE_VALUES),
};
const BASE_CONFIDENCE_REASON_SET = new Set<string>(BASE_CONFIDENCE_REASON_KEYS);
const RANK_ROBUSTNESS_LABELS = new Set([
  "clear-margin",
  "crowded-field",
  "narrow-margin",
  "concentration-adjusted",
]);
const BLUECHIP_GRADES = new Set<string>(BluechipGradeSchema.options);
const SAFETY_GRADES = new Set([...BLUECHIP_GRADES, "NR"]);
const REQUIRED_METHODOLOGY_KEYS = [
  "safetyScore",
  "pegScoreAndDews",
  "yieldIntelligence",
  "bluechipAlignment",
  "exclusionFilters",
] as const;

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
  const profile = candidate.profile;
  if (typeof profile !== "string" || !SELECTOR_PROFILE_SET.has(profile) || !isSelectorInputShape(candidate, profile)) {
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

function attachVerifiedSnapshotBinding(snapshot: SelectorOutput): SelectorOutput {
  return {
    ...snapshot,
    provenance: "pharos-verified",
    snapshotSchemaVersion: 3,
    verification: {
      kind: SELECTOR_SNAPSHOT_VERIFICATION_KIND,
      datasetHash: snapshot.datasetHash,
      engineVersion: snapshot.engineVersion,
    },
  };
}

export function createVerifiedSelectorSnapshot(output: SelectorOutput): SelectorOutput {
  const validation = validateSelectorSnapshot(output);
  if (!validation.ok) {
    throw new Error("Server-recomputed selector output failed snapshot validation");
  }
  return attachVerifiedSnapshotBinding(validation.snapshot);
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
  const verified = attachVerifiedSnapshotBinding(normalized);
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 64
    && value.every((item) => typeof item === "string" && item.length <= 128);
}

function isKnownStringArray(value: unknown, allowed: ReadonlySet<string>): value is string[] {
  return Array.isArray(value)
    && value.length <= allowed.size
    && value.every((item) => typeof item === "string" && allowed.has(item));
}

function isRequiredArrayOf(
  value: unknown,
  itemGuard: (item: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every(itemGuard);
}

function isNullableNonEmptyString(value: unknown): boolean {
  return value === null || isNonEmptyString(value);
}

function isConfidenceReason(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (BASE_CONFIDENCE_REASON_SET.has(value)) return true;
  if (!value.startsWith("missing-critical-")) return false;
  return WEIGHT_KEY_SET.has(value.slice("missing-critical-".length));
}

function isOptionalConfidenceReasons(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isConfidenceReason));
}

function isOptionalRankRobustness(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.label === "string"
    && RANK_ROBUSTNESS_LABELS.has(value.label)
    && (value.scoreMargin === null || isNumberInRange(value.scoreMargin, 0, 100))
  );
}

function isSelectorInputShape(value: unknown, profile: string): boolean {
  if (!isRecord(value)) return false;
  const venueSet = VENUE_SETS_BY_PROFILE[profile];
  return (
    value.profile === profile
    && typeof value.pegCurrency === "string"
    && SELECTOR_PEG_SET.has(value.pegCurrency)
    && typeof value.horizon === "string"
    && HORIZON_SET.has(value.horizon)
    && typeof value.depegTolerance === "string"
    && DEPEG_TOLERANCE_SET.has(value.depegTolerance)
    && typeof value.composability === "string"
    && COMPOSABILITY_SET.has(value.composability)
    && typeof value.exitSpeed === "string"
    && EXIT_SPEED_SET.has(value.exitSpeed)
    && (value.minApy === null || isNonNegativeNumber(value.minApy))
    && typeof value.yieldNativeOnly === "boolean"
    && typeof value.decentralization === "string"
    && DECENTRALIZATION_SET.has(value.decentralization)
    && typeof value.custodyOk === "string"
    && CUSTODY_OK_SET.has(value.custodyOk)
    && (
      value.venuePreferences === undefined
      || (venueSet != null && isKnownStringArray(value.venuePreferences, venueSet))
    )
  );
}

function isUniverseShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.active)
    && isNonNegativeInteger(value.surviving)
    && value.surviving <= value.active
  );
}

function isSkippedCoinShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id)
    && isNonEmptyString(value.symbol)
    && isStringArray(value.missingSignals)
  );
}

function isCoverageWarningsShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.skippedForCoverageCount)
    && Array.isArray(value.skippedForCoverage)
    && value.skippedForCoverage.length <= 410
    && value.skippedForCoverage.every(isSkippedCoinShape)
    && typeof value.sparse === "boolean"
    && typeof value.uneven === "boolean"
    && isNonNegativeInteger(value.newListingCount)
    && isNonNegativeInteger(value.redistributionCount)
  );
}

function isComponentShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === "string"
    && WEIGHT_KEY_SET.has(value.key)
    && isNumberInRange(value.weight, 0, 100)
    && (value.rawValue === null || isFiniteNumber(value.rawValue))
    && (value.normalizedValue === null || isNumberInRange(value.normalizedValue, 0, 100))
    && isNumberInRange(value.contribution, 0, 100)
    && typeof value.redistributed === "boolean"
  );
}

function isLowestSubDimensionShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === "string"
    && LOWEST_SUB_DIMENSION_SET.has(value.key)
    && isNumberInRange(value.score, 0, 100)
    && isKnownStringArray(value.contextKeys, CONTEXT_KEY_SET)
  );
}

function isChainHintsShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isStringArray(value.topByLiquidity)
    && value.topByLiquidity.length <= 3
    && isStringArray(value.topByYield)
    && value.topByYield.length <= 1
    && (value.primary === null || typeof value.primary === "string")
  );
}

function isRecommendedSourceShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isRecord(value.freshness)) return false;
  return (
    isNonEmptyString(value.protocol)
    && isNonEmptyString(value.chain)
    && (value.sourceKey === undefined || isNullableNonEmptyString(value.sourceKey))
    && (
      value.yieldType === undefined
      || value.yieldType === null
      || (typeof value.yieldType === "string" && YIELD_TYPE_SET.has(value.yieldType))
    )
    && isFiniteNumber(value.apy30d)
    && (value.pharosYieldScore === null || isNumberInRange(value.pharosYieldScore, 0, 100))
    && (value.sourceTvlUsd === undefined || value.sourceTvlUsd === null || isNonNegativeNumber(value.sourceTvlUsd))
    && typeof value.sourceRiskTier === "string"
    && SOURCE_RISK_TIERS.has(value.sourceRiskTier)
    && isNonNegativeNumber(value.freshness.capturedAt)
    && isNonNegativeNumber(value.freshness.ageSeconds)
    && (value.selectionReason === undefined || isNullableNonEmptyString(value.selectionReason))
  );
}

function isPerInputStalenessShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.every(([key, age]) => PER_INPUT_STALENESS_KEYS.has(key) && isNonNegativeNumber(age));
}

function isRecommendationSourceSlotsShape(value: Record<string, unknown>): boolean {
  if (value.profile === "treasury") {
    return value.recommendedSource === null && value.perInputStaleness === null;
  }
  if (value.profile === "yield") {
    return isRecommendedSourceShape(value.recommendedSource) && value.perInputStaleness === null;
  }
  if (value.profile === "trading") {
    return value.recommendedSource === null && isPerInputStalenessShape(value.perInputStaleness);
  }
  return false;
}

function isRecommendationShape(value: unknown, outputProfile: string): boolean {
  if (!isRecord(value)) return false;
  return (
    value.profile === outputProfile
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.symbol)
    && isNonEmptyString(value.name)
    && Number.isInteger(value.rank)
    && (value.rank as number) >= 1
    && (value.rank as number) <= 3
    && isNumberInRange(value.score, 0, 100)
    && isNumberInRange(value.confidence, 0, 100)
    && Array.isArray(value.components)
    && value.components.length <= 16
    && value.components.every(isComponentShape)
    && isKnownStringArray(value.whyKeys, WHY_KEY_SET)
    && value.whyKeys.length <= 4
    && isOptionalConfidenceReasons(value.confidenceReasons)
    && isLowestSubDimensionShape(value.lowestSubDimension)
    && isChainHintsShape(value.chainHints)
    && isOptionalRankRobustness(value.rankRobustness)
    && typeof value.isRecentListing === "boolean"
    && (value.bluechipGrade === null || (typeof value.bluechipGrade === "string" && BLUECHIP_GRADES.has(value.bluechipGrade)))
    && typeof value.safetyGrade === "string"
    && SAFETY_GRADES.has(value.safetyGrade)
    && isNonNegativeNumber(value.supplyUsd)
    && value.isBeta === true
    && isRecommendationSourceSlotsShape(value)
    && (value.relaxedReason === undefined || value.relaxedReason === null || (typeof value.relaxedReason === "string" && EXCLUSION_REASON_SET.has(value.relaxedReason)))
    && (value.whyText === undefined || isNonEmptyString(value.whyText))
    && (value.watchText === undefined || isNonEmptyString(value.watchText))
  );
}

function isLowerRankedShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id)
    && isNonEmptyString(value.symbol)
    && isNonEmptyString(value.name)
    && (value.slot === "A" || value.slot === "B")
    && typeof value.reasonKey === "string"
    && LOWER_RANKED_REASON_SET.has(value.reasonKey)
    && (value.failedComponent === null || (typeof value.failedComponent === "string" && WEIGHT_KEY_SET.has(value.failedComponent)))
    && (value.hypotheticalScore === null || isNumberInRange(value.hypotheticalScore, 0, 100))
    && (value.verdictText === undefined || isNonEmptyString(value.verdictText))
    && (value.teachingText === undefined || isNonEmptyString(value.teachingText))
  );
}

function isMethodologyVersionsShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return REQUIRED_METHODOLOGY_KEYS.every((key) => isNonEmptyString(value[key]));
}

function isExclusionSummaryItemShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.reason === "string"
    && EXCLUSION_REASON_SET.has(value.reason)
    && isNonNegativeInteger(value.count)
    && typeof value.severity === "string"
    && EXCLUSION_SEVERITIES.has(value.severity)
    && isStringArray(value.sampleIds)
  );
}

function isClosestSurvivorShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id)
    && isNonEmptyString(value.symbol)
    && isNonEmptyString(value.failingDimension)
    && isNonEmptyString(value.liveReading)
    && typeof value.reason === "string"
    && EXCLUSION_REASON_SET.has(value.reason)
    && (value.hypotheticalScore === null || isNumberInRange(value.hypotheticalScore, 0, 100))
  );
}

function isRelaxableConstraintShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === "string"
    && RELAXABLE_CONSTRAINT_KEYS.has(value.key)
    && isNonEmptyString(value.label)
    && isNonEmptyString(value.description)
    && typeof value.reason === "string"
    && (EXCLUSION_REASON_SET.has(value.reason) || value.reason === "input-strictness")
  );
}

function isSelectorOutputShape(value: unknown): value is SelectorOutput {
  if (!isRecord(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.profile) || !SELECTOR_PROFILE_SET.has(candidate.profile)) {
    return false;
  }
  return (
    isNonEmptyString(candidate.engineVersion)
    && isNonEmptyString(candidate.datasetHash)
    && isFiniteNumber(candidate.timestamp)
    && isSelectorInputShape(candidate.input, candidate.profile)
    && isUniverseShape(candidate.universe)
    && Array.isArray(candidate.recommended)
    && candidate.recommended.length <= 3
    && candidate.recommended.every((item) => isRecommendationShape(item, candidate.profile as string))
    && Array.isArray(candidate.lowerRanked)
    && candidate.lowerRanked.length <= 2
    && candidate.lowerRanked.every(isLowerRankedShape)
    && isCoverageWarningsShape(candidate.coverageWarnings)
    && typeof candidate.lowConfidence === "boolean"
    && isMethodologyVersionsShape(candidate.methodologyVersions)
    && typeof candidate.usedRelaxedFallback === "boolean"
    && isKnownStringArray(candidate.relaxedReasons, EXCLUSION_REASON_SET)
    && isRequiredArrayOf(candidate.exclusionSummary, isExclusionSummaryItemShape)
    && (candidate.exclusionSummary as unknown[]).length <= 410
    && isRequiredArrayOf(candidate.closestSurvivors, isClosestSurvivorShape)
    && (candidate.closestSurvivors as unknown[]).length <= 3
    && isRequiredArrayOf(candidate.relaxableConstraints, isRelaxableConstraintShape)
    && (candidate.relaxableConstraints as unknown[]).length <= 3
  );
}
