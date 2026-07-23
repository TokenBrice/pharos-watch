import {
  DIMENSION_WEIGHTS,
  scoreToGrade,
} from "@shared/lib/report-card-core";
import type { DimensionKey } from "@shared/types/report-cards";
import type { SafetyChange } from "../lib/telegram-alerts";
import type {
  AlertSafetySourceRow,
  AlertSafetyV9ExplainSnapshot,
  AlertSafetyV9SourceRow,
} from "../lib/alert-safety-source-cache";
import { SAFETY_GRADE_RANK, type SafetySnapshot } from "./telegram-alert-snapshots";

const DIMENSION_KEYS: readonly DimensionKey[] = [
  "pegStability",
  "liquidity",
  "resilience",
  "decentralization",
  "dependencyRisk",
];

const DIMENSION_LABELS: Record<DimensionKey, string> = {
  pegStability: "Peg stability",
  liquidity: "Liquidity / Exit",
  resilience: "Resilience",
  decentralization: "Decentralization",
  dependencyRisk: "Dependency Risk",
};

interface DispatchSafetyDimensionSnapshot {
  grade: string;
  score: number | null;
  detail?: string;
}

interface DispatchSafetyStageSnapshot {
  baseScore?: number | null;
  postPegScore?: number | null;
  postNoLiquidityPenaltyScore?: number | null;
  activeDepegCapScore?: number | null;
  postActiveDepegCapScore?: number | null;
  scoreBeforeVariantCap?: number | null;
  finalScore?: number | null;
  activeDepegCapApplied?: boolean;
  noLiquidityPenaltyApplied?: boolean;
  variantCapApplied?: boolean;
}

interface DispatchSafetyRawInputSnapshot {
  activeDepeg?: boolean;
  activeDepegBps?: number | null;
  variantParentId?: string | null;
}

export interface DispatchSafetyExplainSnapshot {
  schemaVersion?: 1;
  stages?: DispatchSafetyStageSnapshot;
  dimensions?: Partial<Record<DimensionKey, DispatchSafetyDimensionSnapshot>>;
  rawInputs?: DispatchSafetyRawInputSnapshot;
}

export type SafetyChangeWithExplain = SafetyChange & {
  previousExplain?: DispatchSafetyExplainSnapshot;
  currentExplain?: DispatchSafetyExplainSnapshot;
};

/** Native V9 explanation for a model-aware caller; V8 formatting remains unchanged. */
export function buildV9SafetyReason(
  current: Pick<AlertSafetySourceRow, "grade" | "score"> & {
    v9Explain?: {
      reasons: Array<{ code?: string; message: string }>;
      bindingCap: { kind?: string; limit?: number; reason: string } | null;
      weakestPillar: { pillar: string; score: number } | null;
      pillars?: AlertSafetyV9ExplainSnapshot["pillars"];
    };
  },
  previous?: Pick<AlertSafetySourceRow, "grade" | "score"> & {
    v9Explain?: {
      reasons?: Array<{ code?: string; message: string }>;
      bindingCap?: { kind?: string; limit?: number; reason: string } | null;
      weakestPillar?: { pillar: string; score: number } | null;
      pillars?: AlertSafetyV9ExplainSnapshot["pillars"];
    };
  },
): string {
  if (
    current.v9Explain?.bindingCap &&
    (
      current.v9Explain.bindingCap.reason !== previous?.v9Explain?.bindingCap?.reason ||
      current.v9Explain.bindingCap.kind !== previous?.v9Explain?.bindingCap?.kind ||
      current.v9Explain.bindingCap.limit !== previous?.v9Explain?.bindingCap?.limit
    )
  ) {
    return `Reason: ${ensureSentence(current.v9Explain.bindingCap.reason)}`;
  }

  const overallDirection = compareGradeOrScore(
    previous?.grade ?? current.grade,
    current.grade,
    previous?.score ?? null,
    current.score,
  );
  const pillarMovement = largestV9PillarMovement(
    current.v9Explain?.pillars,
    previous?.v9Explain?.pillars,
    overallDirection,
  );
  if (pillarMovement) {
    const direction = pillarMovement.current > pillarMovement.previous ? "improved" : "fell";
    return `Reason: ${capitalize(pillarMovement.pillar)} pillar ${direction} from ${Math.round(pillarMovement.previous)} to ${Math.round(pillarMovement.current)}.`;
  }

  const previousReasons = new Set(previous?.v9Explain?.reasons?.map((reason) => reason.code ?? reason.message) ?? []);
  const reason = current.v9Explain?.reasons.find(
    (candidate) => !previousReasons.has(candidate.code ?? candidate.message),
  )?.message
    ?? current.v9Explain?.reasons[0]?.message;
  if (reason) return `Reason: ${ensureSentence(reason)}`;
  if (current.v9Explain?.weakestPillar) {
    return `Reason: Weakest pillar is ${current.v9Explain.weakestPillar.pillar} (${Math.round(current.v9Explain.weakestPillar.score)}).`;
  }
  return `Reason: Safety Score is ${current.grade}${current.score == null ? "." : ` (${Math.round(current.score)}).`}`;
}

function largestV9PillarMovement(
  current: AlertSafetyV9ExplainSnapshot["pillars"] | undefined,
  previous: AlertSafetyV9ExplainSnapshot["pillars"] | undefined,
  overallDirection: Direction,
): { pillar: keyof AlertSafetyV9ExplainSnapshot["pillars"]; current: number; previous: number } | null {
  if (!current || !previous) return null;
  const movements = (["backing", "exit", "control"] as const)
    .flatMap((pillar) => {
      const currentScore = current[pillar].score;
      const previousScore = previous[pillar].score;
      return currentScore == null || previousScore == null || currentScore === previousScore
        ? []
        : [{ pillar, current: currentScore, previous: previousScore }];
    });
  const directional = overallDirection === "upgrade"
    ? movements.filter((movement) => movement.current > movement.previous)
    : overallDirection === "downgrade"
      ? movements.filter((movement) => movement.current < movement.previous)
      : [];
  return (directional.length > 0 ? directional : movements)
    .sort((left, right) =>
      Math.abs(right.current - right.previous) - Math.abs(left.current - left.previous))[0] ?? null;
}

type Direction = "upgrade" | "downgrade" | "mixed" | "flat";

export function addSafetyReasonLines(
  changes: readonly SafetyChange[],
  currentSafetySnapshot: SafetySnapshot | null,
  previousSafetySnapshot: SafetySnapshot | null,
  currentContextLines: ReadonlyMap<string, string> = new Map(),
): SafetyChangeWithExplain[] {
  return changes.map((change) => {
    const previousRow = previousSafetySnapshot?.[change.stablecoinId];
    const currentRow = currentSafetySnapshot?.[change.stablecoinId];
    const previousExplain = readExplain(previousRow);
    const currentExplain = readExplain(currentRow);
    const enriched: SafetyChangeWithExplain = {
      ...change,
      previousExplain,
      currentExplain,
    };
    const currentV9 = currentRow as AlertSafetyV9SourceRow | undefined;
    const previousV9 = previousRow as AlertSafetyV9SourceRow | undefined;
    enriched.contextLine = currentV9?.v9Explain
      ? buildV9SafetyReason(currentV9, previousV9)
      : buildSafetyReasonLine(enriched, currentContextLines.get(change.stablecoinId));
    return enriched;
  });
}

function buildSafetyReasonLine(
  change: SafetyChangeWithExplain,
  currentContextLine?: string,
): string {
  const reason = chooseSafetyReason(change);
  const now = stripContextPrefix(currentContextLine);
  const withNow = now && !reason.includes(" Now:")
    ? `${ensureSentence(reason)} Now: ${now}.`
    : ensureSentence(reason);
  return `Reason: ${truncate(withNow, 260)}`;
}

function chooseSafetyReason(change: SafetyChangeWithExplain): string {
  const current = change.currentExplain;
  const previous = change.previousExplain;

  if (
    current?.rawInputs?.activeDepeg === true &&
    typeof current.rawInputs.activeDepegBps === "number" &&
    isNewOrTighterActiveDepegCap(current, previous)
  ) {
    return `Active depeg peak ${Math.round(current.rawInputs.activeDepegBps)} bps capped the pre-variant Safety Score at ${formatCapTarget(current.stages?.activeDepegCapScore)}`;
  }

  if (current?.stages?.noLiquidityPenaltyApplied === true && previous?.stages?.noLiquidityPenaltyApplied === false) {
    return "Exit liquidity became unrated, applying the no-liquidity penalty";
  }

  const variantReason = buildVariantCapReason(change);
  if (variantReason) return variantReason;

  const dimensionReason = buildDimensionMovementReason(change);
  if (dimensionReason) return dimensionReason;

  const weakest = findWeakestCurrentDimension(current);
  if (weakest) {
    return `Current weakest driver is ${DIMENSION_LABELS[weakest.key]} ${formatDimensionState(weakest.dimension)}`;
  }

  if (change.oldScore != null && change.newScore != null) {
    const direction = change.newScore > change.oldScore ? "improved" : "declined";
    return `Safety Score ${direction} from ${change.oldScore} to ${change.newScore}`;
  }

  return `Safety grade changed from ${change.oldGrade} to ${change.newGrade}`;
}

function isNewOrTighterActiveDepegCap(
  current: DispatchSafetyExplainSnapshot,
  previous: DispatchSafetyExplainSnapshot | undefined,
): boolean {
  if (current.stages?.activeDepegCapApplied !== true) return false;
  if (!previous?.stages) return false;
  if (previous.stages.activeDepegCapApplied === false) return true;
  const currentCap = current.stages.activeDepegCapScore;
  const previousCap = previous.stages.activeDepegCapScore;
  return typeof currentCap === "number" &&
    typeof previousCap === "number" &&
    currentCap < previousCap;
}

function buildVariantCapReason(change: SafetyChangeWithExplain): string | null {
  const current = change.currentExplain;
  const previous = change.previousExplain;
  if (current?.stages?.variantCapApplied !== true || !previous?.stages) return null;

  const parent = current.rawInputs?.variantParentId ? ` by parent ${current.rawInputs.variantParentId}` : "";
  if (previous.stages.variantCapApplied === false) {
    return `Variant parent cap${parent} limited Safety Score to ${formatGradeScore(change.newGrade, change.newScore)}`;
  }

  if (previous.stages.variantCapApplied === true) {
    const currentFinal = current.stages.finalScore;
    const previousFinal = previous.stages.finalScore;
    if (typeof currentFinal === "number" && typeof previousFinal === "number" && currentFinal < previousFinal) {
      return `Variant parent cap${parent} tightened Safety Score to ${formatGradeScore(change.newGrade, currentFinal)}`;
    }
  }

  return null;
}

function buildDimensionMovementReason(change: SafetyChangeWithExplain): string | null {
  const previous = change.previousExplain?.dimensions;
  const current = change.currentExplain?.dimensions;
  if (!previous || !current) return null;

  const overallDirection = compareGradeOrScore(
    change.oldGrade,
    change.newGrade,
    change.oldScore,
    change.newScore,
  );
  const movements = DIMENSION_KEYS.flatMap((key) => {
    const prev = previous[key];
    const curr = current[key];
    if (!prev || !curr) return [];
    const direction = compareGradeOrScore(prev.grade, curr.grade, prev.score, curr.score);
    const scoreDelta = calculateScoreDelta(prev, curr);
    const gradeChanged = prev.grade !== curr.grade;
    if (direction === "flat" && !gradeChanged && scoreDelta === 0) return [];
    return [{ key, prev, curr, direction, scoreDelta, gradeChanged, magnitude: movementMagnitude(key, prev, curr, scoreDelta) }];
  });

  if (movements.length === 0) return null;
  const directional = overallDirection === "upgrade" || overallDirection === "downgrade"
    ? movements.filter((movement) => movement.direction === overallDirection)
    : [];
  const candidates = directional.length > 0 ? directional : movements;
  const selected = candidates.sort((a, b) => b.magnitude - a.magnitude)[0];
  if (!selected) return null;

  const verb = selected.direction === "upgrade" ? "improved" : selected.direction === "downgrade" ? "fell" : "changed";
  const detail = sanitizeDetail(selected.curr.detail);
  const movement = `${DIMENSION_LABELS[selected.key]} ${verb} ${formatDimensionTransition(selected.prev, selected.curr)}`;
  return detail ? `${ensureSentence(movement)} Now: ${detail}` : movement;
}

function findWeakestCurrentDimension(
  explain: DispatchSafetyExplainSnapshot | undefined,
): { key: DimensionKey; dimension: DispatchSafetyDimensionSnapshot } | null {
  const dimensions = explain?.dimensions;
  if (!dimensions) return null;
  return DIMENSION_KEYS
    .flatMap((key) => {
      const dimension = dimensions[key];
      return dimension ? [{ key, dimension }] : [];
    })
    .sort((a, b) => (a.dimension.score ?? -1) - (b.dimension.score ?? -1))[0] ?? null;
}

function readExplain(row: AlertSafetySourceRow | undefined): DispatchSafetyExplainSnapshot | undefined {
  const raw = (row as (AlertSafetySourceRow & { explain?: unknown }) | undefined)?.explain;
  const record = asRecord(raw);
  if (!record) return undefined;

  const schemaVersion = record.schemaVersion === 1 ? 1 : undefined;
  const stagesRecord = asRecord(record.stages);
  const rawInputsRecord = asRecord(record.rawInputs);
  const dimensionsRecord = asRecord(record.dimensions);
  const explain: DispatchSafetyExplainSnapshot = {};
  if (schemaVersion) explain.schemaVersion = schemaVersion;
  if (stagesRecord) {
    explain.stages = {
      baseScore: readOptionalNullableNumber(stagesRecord.baseScore),
      postPegScore: readOptionalNullableNumber(stagesRecord.postPegScore),
      postNoLiquidityPenaltyScore: readOptionalNullableNumber(stagesRecord.postNoLiquidityPenaltyScore),
      activeDepegCapScore: readOptionalNullableNumber(stagesRecord.activeDepegCapScore),
      postActiveDepegCapScore: readOptionalNullableNumber(stagesRecord.postActiveDepegCapScore),
      scoreBeforeVariantCap: readOptionalNullableNumber(stagesRecord.scoreBeforeVariantCap),
      finalScore: readOptionalNullableNumber(stagesRecord.finalScore),
      activeDepegCapApplied: readBoolean(stagesRecord.activeDepegCapApplied),
      noLiquidityPenaltyApplied: readBoolean(stagesRecord.noLiquidityPenaltyApplied),
      variantCapApplied: readBoolean(stagesRecord.variantCapApplied),
    };
  }
  if (rawInputsRecord) {
    explain.rawInputs = {
      activeDepeg: readBoolean(rawInputsRecord.activeDepeg),
      activeDepegBps: readNullableNumber(rawInputsRecord.activeDepegBps),
      variantParentId: readNullableString(rawInputsRecord.variantParentId),
    };
  }
  if (dimensionsRecord) {
    const dimensions: Partial<Record<DimensionKey, DispatchSafetyDimensionSnapshot>> = {};
    for (const key of DIMENSION_KEYS) {
      const dimension = readDimension(dimensionsRecord[key]);
      if (dimension) dimensions[key] = dimension;
    }
    if (Object.keys(dimensions).length > 0) explain.dimensions = dimensions;
  }

  return Object.keys(explain).length > 0 ? explain : undefined;
}

function readDimension(value: unknown): DispatchSafetyDimensionSnapshot | null {
  const record = asRecord(value);
  if (!record || typeof record.grade !== "string") return null;
  return {
    grade: record.grade,
    score: readNullableNumber(record.score),
    detail: typeof record.detail === "string" ? sanitizeDetail(record.detail) : undefined,
  };
}

function compareGradeOrScore(
  oldGrade: string,
  newGrade: string,
  oldScore: number | null,
  newScore: number | null,
): Direction {
  const oldRank = SAFETY_GRADE_RANK[oldGrade];
  const newRank = SAFETY_GRADE_RANK[newGrade];
  let gradeDirection: Direction = "flat";
  let scoreDirection: Direction = "flat";
  if (oldRank != null && newRank != null && oldRank !== newRank) {
    gradeDirection = newRank > oldRank ? "upgrade" : "downgrade";
  }
  if (oldScore != null && newScore != null && oldScore !== newScore) {
    scoreDirection = newScore > oldScore ? "upgrade" : "downgrade";
  }
  if (
    (gradeDirection === "upgrade" || gradeDirection === "downgrade") &&
    (scoreDirection === "upgrade" || scoreDirection === "downgrade") &&
    gradeDirection !== scoreDirection
  ) {
    return "mixed";
  }
  return gradeDirection !== "flat" ? gradeDirection : scoreDirection;
}

function formatDimensionTransition(
  previous: DispatchSafetyDimensionSnapshot,
  current: DispatchSafetyDimensionSnapshot,
): string {
  const gradePart = `${previous.grade} -> ${current.grade}`;
  if (previous.score != null && current.score != null) {
    return `${gradePart} (${previous.score} -> ${current.score})`;
  }
  return gradePart;
}

function formatDimensionState(dimension: DispatchSafetyDimensionSnapshot): string {
  return dimension.score != null ? `${dimension.grade} (${dimension.score})` : dimension.grade;
}

function formatGradeScore(grade: string, score: number | null): string {
  return score == null ? grade : `${grade} (${score})`;
}

function formatCapTarget(score: number | null | undefined): string {
  return typeof score === "number" ? `${scoreToGrade(score)} (${score})` : "the active-depeg cap";
}

function calculateScoreDelta(
  previous: DispatchSafetyDimensionSnapshot,
  current: DispatchSafetyDimensionSnapshot,
): number {
  if (previous.score != null && current.score != null) return current.score - previous.score;
  if (previous.score != null && current.score == null) return -previous.score;
  if (previous.score == null && current.score != null) return current.score;
  return 0;
}

function movementMagnitude(
  key: DimensionKey,
  previous: DispatchSafetyDimensionSnapshot,
  current: DispatchSafetyDimensionSnapshot,
  scoreDelta: number,
): number {
  const scoreMagnitude = Math.abs(scoreDelta);
  if (scoreMagnitude > 0) return scoreMagnitude * (DIMENSION_WEIGHTS[key] ?? 1);
  const previousRank = SAFETY_GRADE_RANK[previous.grade];
  const currentRank = SAFETY_GRADE_RANK[current.grade];
  if (previousRank == null || currentRank == null) return 0;
  return Math.abs(currentRank - previousRank) * 10 * (DIMENSION_WEIGHTS[key] ?? 1);
}

function stripContextPrefix(line: string | undefined): string | null {
  if (!line) return null;
  const stripped = line.replace(/^Context:\s*/i, "").trim();
  return stripped.length > 0 ? stripped.replace(/\.$/, "") : null;
}

function sanitizeDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (/\b(blacklist|freeze|freezing)\b/i.test(normalized)) return undefined;
  return normalized.length > 0 ? truncate(normalized.replace(/\.$/, ""), 140) : undefined;
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3).trim()}...`;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readOptionalNullableNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
