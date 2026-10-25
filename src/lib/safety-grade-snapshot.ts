import {
  PUBLIC_DATASET_CURRENT_DATE,
  PUBLIC_DATASET_CURRENT_EXPORTS,
  PUBLIC_DATASET_MAX_AGE_DAYS,
} from "@/lib/datasets/public-dataset-current";
import { isThreatBand, type ThreatBand } from "@shared/lib/classification";
import { getV9GradeRiskBucket, type V9GradeRiskBucket } from "@shared/lib/safety-grade-buckets";
import { SAFETY_GRADE_VALUES, type SafetyGrade } from "@shared/types/report-card-grade";

interface ScoresLatestDatasetRow {
  stablecoinId?: unknown;
  safetyScore?: unknown;
  safetyGrade?: unknown;
  dewsScore?: unknown;
  dewsBand?: unknown;
  liquidityScore?: unknown;
}

interface ScoresLatestDataset {
  _meta?: { asOfISO?: unknown };
  rows?: ScoresLatestDatasetRow[];
}

/**
 * One coin's published values in the release's scores-latest dataset, dated by
 * the dataset's `asOfISO`. Unavailable values stay null, never zero.
 */
export interface ScoresLatestSnapshotRow {
  grade: SafetyGrade | null;
  score: number | null;
  dewsScore: number | null;
  dewsBand: ThreatBand | null;
  liquidityScore: number | null;
  /** The dataset's generation clock (ms). */
  asOfMs: number;
}

export interface SnapshotSafetyAssessment {
  grade: SafetyGrade;
  score: number | null;
  bucket: Exclude<V9GradeRiskBucket, "unavailable">;
}

const SCORES_LATEST_DATASET = PUBLIC_DATASET_CURRENT_EXPORTS["scores-latest"] as ScoresLatestDataset;

function assertCurrentPublicDatasetFresh(
  now = new Date(),
  snapshotDate = PUBLIC_DATASET_CURRENT_DATE,
): void {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const snapshotUtc = Date.parse(`${snapshotDate}T00:00:00Z`);
  const ageDays = (todayUtc - snapshotUtc) / 86_400_000;
  // Trusted PR release-data replay proves build integrity, not today's data age.
  // Invalid or future snapshot dates still fail, including in replay context.
  if (!Number.isInteger(ageDays) || ageDays < 0
    || (ageDays > PUBLIC_DATASET_MAX_AGE_DAYS && process.env.PHAROS_PAGES_REPLAY !== "1")) {
    throw new Error(
      `Public scores-latest mirror is stale (${snapshotDate}); `
      + `expected a snapshot no more than ${PUBLIC_DATASET_MAX_AGE_DAYS} days old`,
    );
  }
}

if (process.env.NODE_ENV === "production") {
  assertCurrentPublicDatasetFresh();
}

function isSafetyGrade(value: unknown): value is SafetyGrade {
  return typeof value === "string" && (SAFETY_GRADE_VALUES as readonly string[]).includes(value);
}

export function toSnapshotSafetyAssessment(
  safetyGrade: unknown,
  safetyScore: unknown,
): SnapshotSafetyAssessment | null {
  if (!isSafetyGrade(safetyGrade)) return null;
  const bucket = getV9GradeRiskBucket(safetyGrade);
  if (bucket === "unavailable") return null;
  return {
    grade: safetyGrade,
    score: typeof safetyScore === "number" && Number.isFinite(safetyScore) ? safetyScore : null,
    bucket,
  };
}

function buildAssessmentIndex(): Map<string, SnapshotSafetyAssessment> {
  const index = new Map<string, SnapshotSafetyAssessment>();
  const rows = Array.isArray(SCORES_LATEST_DATASET.rows) ? SCORES_LATEST_DATASET.rows : [];
  for (const row of rows) {
    if (typeof row.stablecoinId !== "string") continue;
    const assessment = toSnapshotSafetyAssessment(row.safetyGrade, row.safetyScore);
    if (assessment) index.set(row.stablecoinId, assessment);
  }
  return index;
}

const ASSESSMENT_BY_STABLECOIN_ID = buildAssessmentIndex();

/**
 * Safety Score grade from the committed `scores-latest` public dataset mirror.
 * Production Pages builds refresh that mirror from the live API before every
 * release (daily via rebuild-pages), so a rendered page carries the grade from
 * the release's snapshot; coins without a rated grade return null.
 */
export function getSnapshotSafetyAssessment(stablecoinId: string): SnapshotSafetyAssessment | null {
  return ASSESSMENT_BY_STABLECOIN_ID.get(stablecoinId) ?? null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Projects one dataset row; a row without a dated generation or any value is unavailable. */
export function toScoresLatestSnapshotRow(
  row: ScoresLatestDatasetRow,
  asOfISO: unknown,
): ScoresLatestSnapshotRow | null {
  const asOfMs = typeof asOfISO === "string" ? Date.parse(asOfISO) : Number.NaN;
  if (!Number.isFinite(asOfMs) || asOfMs <= 0) return null;
  const assessment = toSnapshotSafetyAssessment(row.safetyGrade, row.safetyScore);
  const projected: ScoresLatestSnapshotRow = {
    grade: assessment?.grade ?? null,
    score: assessment?.score ?? null,
    dewsScore: finiteOrNull(row.dewsScore),
    dewsBand: typeof row.dewsBand === "string" && isThreatBand(row.dewsBand) ? row.dewsBand : null,
    liquidityScore: finiteOrNull(row.liquidityScore),
    asOfMs,
  };
  const hasValue = projected.grade !== null
    || projected.dewsBand !== null || projected.liquidityScore !== null;
  return hasValue ? projected : null;
}

const SCORES_LATEST_ROW_BY_STABLECOIN_ID = new Map(
  (Array.isArray(SCORES_LATEST_DATASET.rows) ? SCORES_LATEST_DATASET.rows : []).flatMap((row) => {
    const projected = typeof row.stablecoinId === "string"
      ? toScoresLatestSnapshotRow(row, SCORES_LATEST_DATASET._meta?.asOfISO)
      : null;
    return projected ? [[row.stablecoinId as string, projected] as const] : [];
  }),
);

/** The coin's dated scores-latest values, for the build-time detail snapshot. */
export function getScoresLatestSnapshotRow(stablecoinId: string): ScoresLatestSnapshotRow | null {
  return SCORES_LATEST_ROW_BY_STABLECOIN_ID.get(stablecoinId) ?? null;
}

/**
 * "Safety Score A (83/100) as of 2026-10-22": the dated grade from the same
 * scores-latest mirror and release date as the profile FAQ. Null when unrated.
 */
export function formatSnapshotSafetyScoreLabel(stablecoinId: string): string | null {
  const assessment = getSnapshotSafetyAssessment(stablecoinId);
  if (!assessment) return null;
  const score = assessment.score !== null ? ` (${assessment.score}/100)` : "";
  return `Safety Score ${assessment.grade}${score} as of ${PUBLIC_DATASET_CURRENT_DATE}`;
}
