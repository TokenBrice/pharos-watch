import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { isRecord } from "@shared/lib/type-guards";
import {
  DIMENSION_WEIGHTS,
  NO_LIQUIDITY_PENALTY,
  PEG_MULTIPLIER_EXPONENT,
  WEIGHTED_DIMENSION_KEYS,
} from "@shared/lib/report-card-core";
import { activeDepegCapScore } from "@shared/lib/report-card-active-depeg";
import { round1, roundScore } from "@shared/lib/math";
import type { DimensionKey, ReportCard, ReportCardGrade, SafetyAlertSourceState } from "@shared/types";
import type { ReportCardPublicationCompleteness } from "./report-card-publication";

export const ALERT_SAFETY_SOURCE_CACHE_KEY = "alert:safety-source-cache";
const ALERT_SAFETY_SOURCE_SCHEMA_VERSION = "1";
const ALERT_SAFETY_SOURCE_STALE_PRODUCER_INTERVALS = 2;
const ALERT_SAFETY_EXPLAIN_SCHEMA_VERSION = 1;
const ALERT_SAFETY_DETAIL_MAX_CHARS = 160;

const DIMENSION_KEYS = Object.keys(DIMENSION_WEIGHTS) as DimensionKey[];

export type AlertSafetySourceState = SafetyAlertSourceState;

export interface AlertSafetyDimensionSnapshot {
  grade: ReportCardGrade | string;
  score: number | null;
  detail?: string;
}

export interface AlertSafetyStageSnapshot {
  baseScore: number | null;
  postPegScore: number | null;
  postNoLiquidityPenaltyScore: number | null;
  activeDepegCapScore: number | null;
  postActiveDepegCapScore: number | null;
  scoreBeforeVariantCap: number | null;
  finalScore: number | null;
  noLiquidityPenaltyApplied: boolean;
  activeDepegCapApplied: boolean;
  variantCapApplied: boolean;
}

export interface AlertSafetyRawInputSnapshot {
  pegScore: number | null;
  activeDepeg: boolean;
  activeDepegBps: number | null;
  liquidityScore: number | null;
  effectiveExitScore: number | null;
  redemptionBackstopScore: number | null;
  redemptionUsedForLiquidity: boolean;
  redemptionRouteFamily: string | null;
  redemptionModelConfidence: string | null;
  redemptionExclusionReason: string | null;
  redemptionImmediateCapacityUsd: number | null;
  redemptionImmediateCapacityRatio: number | null;
  concentrationHhi: number | null;
  /** Display-only under the current methodology; never use as a causal reason. */
  canBeBlacklisted: boolean | "possible" | "inherited";
  collateralFromLive: boolean;
  dependencyFromLive: boolean;
  dependencyCount: number;
  variantParentId: string | null;
  navToken: boolean;
}

export interface AlertSafetyExplainSnapshot {
  schemaVersion: 1;
  stages: AlertSafetyStageSnapshot;
  dimensions: Record<DimensionKey, AlertSafetyDimensionSnapshot>;
  rawInputs: AlertSafetyRawInputSnapshot;
}

export interface AlertSafetySourceRow {
  grade: string;
  score: number | null;
  methodologyVersion: string | null;
  explain?: AlertSafetyExplainSnapshot;
}

export type AlertSafetySourceSnapshot = Record<string, AlertSafetySourceRow>;

export interface AlertSafetySourceEnvelope {
  generation: string;
  publicationGenerationId?: string;
  methodologyVersion: string;
  publishedAt: number;
  completeness?: ReportCardPublicationCompleteness;
  snapshot: AlertSafetySourceSnapshot;
}

export interface AlertSafetySnapshotEnvelope {
  generation: string;
  snapshot: AlertSafetySourceSnapshot;
}

export interface AlertSafetySourceAssessment {
  state: AlertSafetySourceState;
  ageSeconds: number | null;
  generation: string | null;
  envelope: AlertSafetySourceEnvelope | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function parseNumberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function roundStageScore(value: number | null): number | null {
  return value == null ? null : round1(value);
}

function clampAndRoundFinalScore(value: number | null): number | null {
  return value == null ? null : roundScore(value);
}

function truncateDetail(value: string): string {
  if (value.length <= ALERT_SAFETY_DETAIL_MAX_CHARS) return value;
  return `${value.slice(0, ALERT_SAFETY_DETAIL_MAX_CHARS - 3)}...`;
}

function parseBlacklistStatus(value: unknown): AlertSafetyRawInputSnapshot["canBeBlacklisted"] | undefined {
  if (typeof value === "boolean") return value;
  if (value === "possible" || value === "inherited") return value;
  if (value === "dilutable") return "possible";
  if (value === "possible-inherited") return "inherited";
  return undefined;
}

function parseDimensionSnapshot(value: unknown): AlertSafetyDimensionSnapshot | null {
  const record = asRecord(value);
  if (!record || typeof record.grade !== "string" || !isFiniteNumberOrNull(record.score)) {
    return null;
  }

  const dimension: AlertSafetyDimensionSnapshot = {
    grade: record.grade,
    score: record.score,
  };
  if (typeof record.detail === "string") {
    dimension.detail = truncateDetail(record.detail);
  }
  return dimension;
}

function parseDimensionSnapshots(value: unknown): Record<DimensionKey, AlertSafetyDimensionSnapshot> | null {
  const record = asRecord(value);
  if (!record) return null;

  const dimensions = {} as Record<DimensionKey, AlertSafetyDimensionSnapshot>;
  for (const key of DIMENSION_KEYS) {
    const dimension = parseDimensionSnapshot(record[key]);
    if (!dimension) return null;
    dimensions[key] = dimension;
  }
  return dimensions;
}

function parseStageSnapshot(value: unknown): AlertSafetyStageSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;

  const baseScore = parseNumberOrNull(record.baseScore);
  const postPegScore = parseNumberOrNull(record.postPegScore);
  const postNoLiquidityPenaltyScore = parseNumberOrNull(record.postNoLiquidityPenaltyScore);
  const capScore = parseNumberOrNull(record.activeDepegCapScore);
  const postActiveDepegCapScore = parseNumberOrNull(record.postActiveDepegCapScore);
  const scoreBeforeVariantCap = parseNumberOrNull(record.scoreBeforeVariantCap);
  const finalScore = parseNumberOrNull(record.finalScore);

  if (
    baseScore === undefined ||
    postPegScore === undefined ||
    postNoLiquidityPenaltyScore === undefined ||
    capScore === undefined ||
    postActiveDepegCapScore === undefined ||
    scoreBeforeVariantCap === undefined ||
    finalScore === undefined ||
    typeof record.noLiquidityPenaltyApplied !== "boolean" ||
    typeof record.activeDepegCapApplied !== "boolean" ||
    typeof record.variantCapApplied !== "boolean"
  ) {
    return null;
  }

  return {
    baseScore,
    postPegScore,
    postNoLiquidityPenaltyScore,
    activeDepegCapScore: capScore,
    postActiveDepegCapScore,
    scoreBeforeVariantCap,
    finalScore,
    noLiquidityPenaltyApplied: record.noLiquidityPenaltyApplied,
    activeDepegCapApplied: record.activeDepegCapApplied,
    variantCapApplied: record.variantCapApplied,
  };
}

interface SharedRawFields {
  pegScore: number | null | undefined;
  activeDepegBps: number | null | undefined;
  liquidityScore: number | null | undefined;
  effectiveExitScore: number | null | undefined;
  redemptionBackstopScore: number | null | undefined;
  redemptionImmediateCapacityUsd: number | null | undefined;
  redemptionImmediateCapacityRatio: number | null | undefined;
  concentrationHhi: number | null | undefined;
  canBeBlacklisted: AlertSafetyRawInputSnapshot["canBeBlacklisted"] | undefined;
  redemptionRouteFamily: string | null | undefined;
  redemptionModelConfidence: string | null | undefined;
  variantParentId: string | null | undefined;
}

// Extracts the fields parsed identically by both the cached-record validator
// and the live-card projector. Each caller keeps its own undefined guards and
// its divergent fields (e.g. redemptionExclusionReason, dependencyCount).
function parseSharedRawFields(record: Record<string, unknown>): SharedRawFields {
  return {
    pegScore: parseNumberOrNull(record.pegScore),
    activeDepegBps: parseNumberOrNull(record.activeDepegBps),
    liquidityScore: parseNumberOrNull(record.liquidityScore),
    effectiveExitScore: parseNumberOrNull(record.effectiveExitScore),
    redemptionBackstopScore: parseNumberOrNull(record.redemptionBackstopScore),
    redemptionImmediateCapacityUsd: parseNumberOrNull(record.redemptionImmediateCapacityUsd),
    redemptionImmediateCapacityRatio: parseNumberOrNull(record.redemptionImmediateCapacityRatio),
    concentrationHhi: parseNumberOrNull(record.concentrationHhi),
    canBeBlacklisted: parseBlacklistStatus(record.canBeBlacklisted),
    redemptionRouteFamily: parseStringOrNull(record.redemptionRouteFamily),
    redemptionModelConfidence: parseStringOrNull(record.redemptionModelConfidence),
    variantParentId: parseStringOrNull(record.variantParentId),
  };
}

function parseRawInputSnapshot(value: unknown): AlertSafetyRawInputSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;

  const {
    pegScore,
    activeDepegBps,
    liquidityScore,
    effectiveExitScore,
    redemptionBackstopScore,
    redemptionImmediateCapacityUsd,
    redemptionImmediateCapacityRatio,
    concentrationHhi,
    canBeBlacklisted,
    redemptionRouteFamily,
    redemptionModelConfidence,
    variantParentId,
  } = parseSharedRawFields(record);
  const redemptionExclusionReason = record.redemptionExclusionReason === undefined
    ? null
    : parseStringOrNull(record.redemptionExclusionReason);

  if (
    pegScore === undefined ||
    activeDepegBps === undefined ||
    liquidityScore === undefined ||
    effectiveExitScore === undefined ||
    redemptionBackstopScore === undefined ||
    redemptionImmediateCapacityUsd === undefined ||
    redemptionImmediateCapacityRatio === undefined ||
    concentrationHhi === undefined ||
    canBeBlacklisted === undefined ||
    redemptionRouteFamily === undefined ||
    redemptionModelConfidence === undefined ||
    redemptionExclusionReason === undefined ||
    variantParentId === undefined ||
    typeof record.activeDepeg !== "boolean" ||
    typeof record.redemptionUsedForLiquidity !== "boolean" ||
    typeof record.collateralFromLive !== "boolean" ||
    typeof record.dependencyFromLive !== "boolean" ||
    typeof record.dependencyCount !== "number" ||
    !Number.isInteger(record.dependencyCount) ||
    record.dependencyCount < 0 ||
    typeof record.navToken !== "boolean"
  ) {
    return null;
  }

  return {
    pegScore,
    activeDepeg: record.activeDepeg,
    activeDepegBps,
    liquidityScore,
    effectiveExitScore,
    redemptionBackstopScore,
    redemptionUsedForLiquidity: record.redemptionUsedForLiquidity,
    redemptionRouteFamily,
    redemptionModelConfidence,
    redemptionExclusionReason,
    redemptionImmediateCapacityUsd,
    redemptionImmediateCapacityRatio,
    concentrationHhi,
    canBeBlacklisted,
    collateralFromLive: record.collateralFromLive,
    dependencyFromLive: record.dependencyFromLive,
    dependencyCount: record.dependencyCount,
    variantParentId,
    navToken: record.navToken,
  };
}

function parseExplainSnapshot(value: unknown): AlertSafetyExplainSnapshot | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== ALERT_SAFETY_EXPLAIN_SCHEMA_VERSION) return undefined;

  const stages = parseStageSnapshot(record.stages);
  const dimensions = parseDimensionSnapshots(record.dimensions);
  const rawInputs = parseRawInputSnapshot(record.rawInputs);
  if (!stages || !dimensions || !rawInputs) return undefined;

  return {
    schemaVersion: ALERT_SAFETY_EXPLAIN_SCHEMA_VERSION,
    stages,
    dimensions,
    rawInputs,
  };
}

function parseSnapshotRow(value: unknown): AlertSafetySourceRow | null {
  const record = asRecord(value);
  if (!record) return null;

  if (
    typeof record.grade !== "string" ||
    !("score" in record) ||
    !isFiniteNumberOrNull(record.score) ||
    !("methodologyVersion" in record) ||
    !(record.methodologyVersion === null || typeof record.methodologyVersion === "string")
  ) {
    return null;
  }

  const row: AlertSafetySourceRow = {
    grade: record.grade,
    score: record.score,
    methodologyVersion: record.methodologyVersion,
  };
  const explain = parseExplainSnapshot(record.explain);
  if (explain) {
    row.explain = explain;
  }
  return row;
}

function parseSnapshot(value: unknown): AlertSafetySourceSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;

  const snapshot: AlertSafetySourceSnapshot = {};
  let validRows = 0;
  for (const [stablecoinId, rowValue] of Object.entries(record)) {
    const row = parseSnapshotRow(rowValue);
    if (row) {
      snapshot[stablecoinId] = row;
      validRows++;
    }
  }
  return Object.keys(record).length === 0 || validRows > 0 ? snapshot : null;
}

function parseCachedValue(cached: { value: string; updatedAt: number } | null): unknown | null {
  if (!cached) return null;
  try {
    return JSON.parse(cached.value) as unknown;
  } catch {
    return null;
  }
}

function buildDimensionSnapshotFromCard(card: ReportCard, key: DimensionKey): AlertSafetyDimensionSnapshot | null {
  const dimensions = asRecord((card as { dimensions?: unknown }).dimensions);
  const dimension = parseDimensionSnapshot(dimensions?.[key]);
  return dimension;
}

function buildRawInputSnapshotFromCard(card: ReportCard): AlertSafetyRawInputSnapshot | null {
  const record = asRecord((card as { rawInputs?: unknown }).rawInputs);
  if (!record) return null;

  const {
    pegScore,
    activeDepegBps,
    liquidityScore,
    effectiveExitScore,
    redemptionBackstopScore,
    redemptionImmediateCapacityUsd,
    redemptionImmediateCapacityRatio,
    concentrationHhi,
    canBeBlacklisted,
    redemptionRouteFamily,
    redemptionModelConfidence,
    variantParentId,
  } = parseSharedRawFields(record);
  const collateralFromLive = typeof record.collateralFromLive === "boolean" ? record.collateralFromLive : false;
  const dependencyFromLive = typeof record.dependencyFromLive === "boolean" ? record.dependencyFromLive : false;

  if (
    pegScore === undefined ||
    activeDepegBps === undefined ||
    liquidityScore === undefined ||
    effectiveExitScore === undefined ||
    redemptionBackstopScore === undefined ||
    redemptionImmediateCapacityUsd === undefined ||
    redemptionImmediateCapacityRatio === undefined ||
    concentrationHhi === undefined ||
    canBeBlacklisted === undefined ||
    redemptionRouteFamily === undefined ||
    redemptionModelConfidence === undefined ||
    variantParentId === undefined ||
    typeof record.activeDepeg !== "boolean" ||
    typeof record.redemptionUsedForLiquidity !== "boolean" ||
    !Array.isArray(record.dependencies) ||
    typeof record.navToken !== "boolean"
  ) {
    return null;
  }

  return {
    pegScore,
    activeDepeg: record.activeDepeg,
    activeDepegBps,
    liquidityScore,
    effectiveExitScore,
    redemptionBackstopScore,
    redemptionUsedForLiquidity: record.redemptionUsedForLiquidity,
    redemptionRouteFamily,
    redemptionModelConfidence,
    redemptionExclusionReason: null,
    redemptionImmediateCapacityUsd,
    redemptionImmediateCapacityRatio,
    concentrationHhi,
    canBeBlacklisted,
    collateralFromLive,
    dependencyFromLive,
    dependencyCount: record.dependencies.length,
    variantParentId,
    navToken: record.navToken,
  };
}

export function getAlertSafetySourceGeneration(methodologyVersion = SAFETY_SCORE_METHODOLOGY_VERSION): string {
  return `safety-${methodologyVersion}-alert-source-v${ALERT_SAFETY_SOURCE_SCHEMA_VERSION}`;
}

/**
 * Reproduces the unrounded weighted base mean from `computeOverallGrade`
 * (shared/lib/report-card-overall.ts) so the explain snapshot applies the peg
 * multiplier and downstream stages to the same pre-round1 value the scoring
 * engine used — not to the rounded `card.baseScore`. Returns null when fewer
 * than two non-peg dimensions are rated (mirrors the NR guard there).
 */
function rawBaseWeightedMean(
  dimensions: Record<DimensionKey, AlertSafetyDimensionSnapshot>,
): number | null {
  let ratedWeight = 0;
  let weightedSum = 0;
  let baseRatedCount = 0;
  for (const key of WEIGHTED_DIMENSION_KEYS) {
    const score = dimensions[key].score;
    if (score !== null) {
      ratedWeight += DIMENSION_WEIGHTS[key];
      weightedSum += score * DIMENSION_WEIGHTS[key];
      baseRatedCount++;
    }
  }
  if (baseRatedCount < 2 || ratedWeight === 0) return null;
  return weightedSum / ratedWeight;
}

function buildAlertSafetyExplainSnapshot(card: ReportCard): AlertSafetyExplainSnapshot | undefined {
  const dimensions = {} as Record<DimensionKey, AlertSafetyDimensionSnapshot>;
  for (const key of DIMENSION_KEYS) {
    const dimension = buildDimensionSnapshotFromCard(card, key);
    if (!dimension) return undefined;
    dimensions[key] = dimension;
  }

  const rawInputs = buildRawInputSnapshotFromCard(card);
  if (!rawInputs) return undefined;

  const pegScore = dimensions.pegStability.score;
  const liquidityScore = dimensions.liquidity.score;
  const baseScore = parseNumberOrNull((card as { baseScore?: unknown }).baseScore);
  const overallScore = parseNumberOrNull((card as { overallScore?: unknown }).overallScore);
  const rawUncappedOverallScore = (card as { uncappedOverallScore?: unknown }).uncappedOverallScore;
  const uncappedOverallScore = rawUncappedOverallScore === undefined
    ? null
    : parseNumberOrNull(rawUncappedOverallScore);
  if (baseScore === undefined || overallScore === undefined || uncappedOverallScore === undefined) {
    return undefined;
  }

  let postPegScore: number | null = null;

  // Apply the peg multiplier to the unrounded weighted mean, exactly as
  // computeOverallGrade does. Reconstructing it from the dimension scores
  // avoids re-deriving from the rounded card.baseScore (which diverges
  // slightly from the value the scoring engine actually used). Fall back to
  // baseScore only when the mean cannot be reconstructed.
  const pegMultiplierBase = rawBaseWeightedMean(dimensions) ?? baseScore;

  if (pegMultiplierBase != null) {
    if (pegScore != null) {
      postPegScore = pegScore === 0
        ? 0
        : pegMultiplierBase * Math.pow(pegScore / 100, PEG_MULTIPLIER_EXPONENT);
    } else if (rawInputs.navToken) {
      postPegScore = pegMultiplierBase;
    }
  }

  const noLiquidityPenaltyApplied = postPegScore != null && liquidityScore === null;
  const postNoLiquidityPenaltyScore = postPegScore == null
    ? null
    : postPegScore * (noLiquidityPenaltyApplied ? NO_LIQUIDITY_PENALTY : 1);
  const capScore = activeDepegCapScore(rawInputs.activeDepegBps);
  const activeDepegCapApplied = capScore != null &&
    postNoLiquidityPenaltyScore != null &&
    postNoLiquidityPenaltyScore > capScore;
  const postActiveDepegCapScore = postNoLiquidityPenaltyScore == null
    ? null
    : capScore == null
      ? postNoLiquidityPenaltyScore
      : Math.min(postNoLiquidityPenaltyScore, capScore);
  const scoreBeforeVariantCap = card.overallCapped === true && uncappedOverallScore != null
    ? uncappedOverallScore
    : clampAndRoundFinalScore(postActiveDepegCapScore);
  const variantCapApplied = card.overallCapped === true &&
    scoreBeforeVariantCap != null &&
    overallScore != null &&
    scoreBeforeVariantCap > overallScore;

  return {
    schemaVersion: ALERT_SAFETY_EXPLAIN_SCHEMA_VERSION,
    stages: {
      baseScore: roundStageScore(baseScore),
      postPegScore: roundStageScore(postPegScore),
      postNoLiquidityPenaltyScore: roundStageScore(postNoLiquidityPenaltyScore),
      activeDepegCapScore: capScore,
      postActiveDepegCapScore: roundStageScore(postActiveDepegCapScore),
      scoreBeforeVariantCap,
      finalScore: overallScore,
      noLiquidityPenaltyApplied,
      activeDepegCapApplied,
      variantCapApplied,
    },
    dimensions,
    rawInputs,
  };
}

function buildAlertSafetySourceSnapshot(
  cards: ReportCard[],
  methodologyVersion: string,
): AlertSafetySourceSnapshot {
  const snapshot: AlertSafetySourceSnapshot = {};

  for (const card of cards) {
    if (card.isDefunct) continue;
    const explain = buildAlertSafetyExplainSnapshot(card);
    snapshot[card.id] = {
      grade: card.overallGrade,
      score: card.overallScore ?? null,
      methodologyVersion,
      ...(explain ? { explain } : {}),
    };
  }

  return snapshot;
}

export function buildAlertSafetySourceEnvelope(
  cards: ReportCard[],
  methodologyVersion: string,
  publishedAt: number,
  completeness?: ReportCardPublicationCompleteness,
): AlertSafetySourceEnvelope {
  return {
    generation: getAlertSafetySourceGeneration(methodologyVersion),
    ...(completeness ? { publicationGenerationId: completeness.generationId, completeness } : {}),
    methodologyVersion,
    publishedAt,
    snapshot: buildAlertSafetySourceSnapshot(cards, methodologyVersion),
  };
}

function parseAlertSafetySourceEnvelope(
  cached: { value: string; updatedAt: number } | null,
): AlertSafetySourceEnvelope | null {
  const parsed = parseCachedValue(cached);
  const record = asRecord(parsed);
  if (!record) return null;

  const generation = typeof record.generation === "string" ? record.generation : null;
  const methodologyVersion = typeof record.methodologyVersion === "string" ? record.methodologyVersion : null;
  const publicationGenerationId = typeof record.publicationGenerationId === "string"
    ? record.publicationGenerationId
    : null;
  const publishedAt = typeof record.publishedAt === "number" ? record.publishedAt : null;
  const snapshot = parseSnapshot(record.snapshot);

  const completenessRecord = asRecord(record.completeness);
  const completeness = completenessRecord
    && typeof completenessRecord.generationId === "string"
    && typeof completenessRecord.methodologyVersion === "string"
    && typeof completenessRecord.expectedCount === "number"
    && typeof completenessRecord.scoredCount === "number"
    && typeof completenessRecord.notRatedCount === "number"
    && Array.isArray(completenessRecord.notRatedIds)
    && completenessRecord.notRatedIds.every((id) => typeof id === "string")
    && completenessRecord.expectedCount === completenessRecord.scoredCount + completenessRecord.notRatedCount
      ? completenessRecord as unknown as ReportCardPublicationCompleteness
      : null;

  if (
    !generation
    || !methodologyVersion
    || publishedAt == null
    || !snapshot
    || (record.completeness != null && !completeness)
    || (completeness && publicationGenerationId !== completeness.generationId)
  ) {
    return null;
  }

  return {
    generation,
    ...(publicationGenerationId ? { publicationGenerationId } : {}),
    methodologyVersion,
    publishedAt,
    ...(completeness ? { completeness } : {}),
    snapshot,
  };
}

export function assessAlertSafetySourceCache(
  cached: { value: string; updatedAt: number } | null,
  options: {
    expectedGeneration?: string;
    nowSec: number;
    producerIntervalSec: number;
  },
): AlertSafetySourceAssessment {
  const expectedGeneration = options.expectedGeneration ?? getAlertSafetySourceGeneration();
  if (!cached) {
    return {
      state: "missing",
      ageSeconds: null,
      generation: null,
      envelope: null,
    };
  }

  const envelope = parseAlertSafetySourceEnvelope(cached);
  if (!envelope) {
    return {
      state: "corrupt",
      ageSeconds: null,
      generation: null,
      envelope: null,
    };
  }

  const ageSeconds = Math.max(0, options.nowSec - envelope.publishedAt);
  if (envelope.generation !== expectedGeneration) {
    return {
      state: "wrong-generation",
      ageSeconds,
      generation: envelope.generation,
      envelope,
    };
  }

  if (ageSeconds > options.producerIntervalSec * ALERT_SAFETY_SOURCE_STALE_PRODUCER_INTERVALS) {
    return {
      state: "stale",
      ageSeconds,
      generation: envelope.generation,
      envelope,
    };
  }

  return {
    state: "ok",
    ageSeconds,
    generation: envelope.generation,
    envelope,
  };
}

export function buildAlertSafetySnapshotEnvelope(
  snapshot: AlertSafetySourceSnapshot,
  generation: string,
): AlertSafetySnapshotEnvelope {
  return {
    generation,
    snapshot,
  };
}

export function parseAlertSafetySnapshotEnvelope(
  cached: { value: string; updatedAt: number } | null,
): AlertSafetySnapshotEnvelope | null {
  const parsed = parseCachedValue(cached);
  const record = asRecord(parsed);
  if (!record) return null;

  if ("generation" in record || "snapshot" in record) {
    const generation = typeof record.generation === "string" ? record.generation : null;
    const snapshot = parseSnapshot(record.snapshot);
    if (generation == null || snapshot == null) return null;

    return {
      generation,
      snapshot,
    };
  }

  const legacySnapshot = parseSnapshot(record);
  if (!legacySnapshot) return null;

  return {
    generation: "",
    snapshot: legacySnapshot,
  };
}
