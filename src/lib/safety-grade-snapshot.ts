import {
  PUBLIC_DATASET_CURRENT_DATE,
  PUBLIC_DATASET_CURRENT_EXPORTS,
  PUBLIC_DATASET_MAX_AGE_DAYS,
} from "@/lib/datasets/public-dataset-current";
import { getV9GradeRiskBucket, type V9GradeRiskBucket } from "@shared/lib/safety-grade-buckets";
import { SAFETY_GRADE_VALUES, type SafetyGrade } from "@shared/types/report-card-grade";

interface ScoresLatestDatasetRow {
  stablecoinId?: unknown;
  safetyScore?: unknown;
  safetyGrade?: unknown;
}

interface ScoresLatestDataset {
  rows?: ScoresLatestDatasetRow[];
}

export interface SnapshotSafetyAssessment {
  grade: SafetyGrade;
  score: number | null;
  bucket: Exclude<V9GradeRiskBucket, "unavailable">;
}

const SCORES_LATEST_DATASET = PUBLIC_DATASET_CURRENT_EXPORTS["scores-latest"] as ScoresLatestDataset;

export function assertCurrentPublicDatasetFresh(
  now = new Date(),
  snapshotDate = PUBLIC_DATASET_CURRENT_DATE,
): void {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const snapshotUtc = Date.parse(`${snapshotDate}T00:00:00Z`);
  const ageDays = (todayUtc - snapshotUtc) / 86_400_000;
  if (!Number.isInteger(ageDays) || ageDays < 0 || ageDays > PUBLIC_DATASET_MAX_AGE_DAYS) {
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
