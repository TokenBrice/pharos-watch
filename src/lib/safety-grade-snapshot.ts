import {
  PUBLIC_DATASET_CURRENT_DATE,
  PUBLIC_DATASET_CURRENT_EXPORTS,
  PUBLIC_DATASET_MAX_AGE_DAYS,
} from "@/lib/datasets/public-dataset-current";
import { isThreatBand, type ThreatBand } from "@shared/lib/classification";
import { getV9GradeRiskBucket, type V9GradeRiskBucket } from "@shared/lib/safety-grade-buckets";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { SAFETY_GRADE_VALUES, type SafetyGrade } from "@shared/types/report-card-grade";
import { V9PublicationHealthSchema, type V9PublicationHealth } from "@shared/types/report-cards-v9";
import { SafetyScoreV9CompletenessSchema } from "@shared/types/safety-score-v9-public";
import { scoreToGrade } from "@shared/types/safety-score-v9-grade";
import {
  SafetyScoreV9PublicationIdentitySchema,
  type SafetyScoreV9PublicationIdentity,
} from "@shared/types/safety-score-publication";
import { z } from "zod";

interface ScoresLatestDatasetRow {
  stablecoinId?: unknown;
  safetyScore?: unknown;
  safetyGrade?: unknown;
  dewsScore?: unknown;
  dewsBand?: unknown;
  liquidityScore?: unknown;
  ratingStatus?: unknown;
  safetyDisplay?: unknown;
}

interface ScoresLatestDataset {
  _meta?: { asOfISO?: unknown; methodologyLabel?: unknown; displayProjection?: unknown };
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

// --- Bounded Safety Scores preview -----------------------------------------
// The preview is a build-time projection of the current scores-latest export.
// It is never a query-cache envelope: client components receive only this
// bounded serializable object and import its type, not the dataset.

export interface SafetyScoresPreviewRow {
  id: string;
  name: string;
  symbol: string;
  href: string;
  grade: SafetyGrade;
  score: number;
  provisional: boolean;
  /** Recorded raw score band when the published letter is held; never re-derived. */
  gradeHoldRawGrade: SafetyGrade | null;
}

export interface SafetyScoresPreviewCompleteness {
  expectedCount: number;
  ratedCount: number;
  notRatedCount: number;
  pipelineGapCount: number;
}

export interface SafetyScoresPreview {
  kind: "safety-grade-preview";
  rows: readonly SafetyScoresPreviewRow[];
  shownCount: number;
  eligibleRatedCount: number;
  publicationCompleteness: SafetyScoresPreviewCompleteness;
  publicationHealth: V9PublicationHealth;
  identity: SafetyScoreV9PublicationIdentity;
  publishedAtSec: number;
  capturedAtSec: number;
  snapshotDate: string;
  expiresAtSec: number;
}

type RegistryIdentity = Pick<StablecoinMeta, "id" | "name" | "symbol">;

const SafetyScoresPreviewSafetyProjectionSchema = z
  .object({
    identity: SafetyScoreV9PublicationIdentitySchema,
    asOfSec: z.number().int().nonnegative(),
    publishedAtSec: z.number().int().nonnegative(),
    sourceGenerations: z.record(z.string().min(1), z.string().min(1)),
    publicationHealth: V9PublicationHealthSchema,
    completeness: SafetyScoreV9CompletenessSchema,
  })
  .strict();

/** Fields both projection versions share; this preview reads only the Safety block. */
const SAFETY_SCORES_PREVIEW_PROJECTION_FIELDS = {
  snapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  capturedAtSec: z.number().int().nonnegative(),
  sourceSnapshotPath: z.string().min(1),
  safety: SafetyScoresPreviewSafetyProjectionSchema.nullable(),
  safetyUnavailableReason: z.literal("legacy-source-metadata-unavailable").nullable(),
} as const;

/**
 * v1 is the pre-open-evidence projection still present in retained dated
 * artifacts and pre-cutover mirrors; v2 adds the open-question counts, which
 * this scores-only preview never reads, so they stay opaque here. Any other
 * version is unrecognized: the page serves its neutral skeleton and the build
 * wrapper warns with the reason instead of quietly dropping the preview.
 */
const SafetyScoresPreviewDisplayProjectionSchema = z.discriminatedUnion("version", [
  z
    .object({
      version: z.literal(1),
      ...SAFETY_SCORES_PREVIEW_PROJECTION_FIELDS,
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      ...SAFETY_SCORES_PREVIEW_PROJECTION_FIELDS,
      openEvidence: z.unknown(),
      openEvidenceUnavailableReason: z.unknown(),
    })
    .strict(),
]);

const SafetyScoresPreviewDatasetSchema = z
  .object({
    _meta: z
      .object({
        methodologyLabel: z.string().optional(),
        displayProjection: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    rows: z.array(z.unknown()),
  })
  .passthrough();

const SafetyScoresPreviewRowSchema = z
  .object({
    stablecoinId: z.string().min(1),
    safetyScore: z.number().finite().nullable().optional(),
    safetyGrade: z.string().nullable().optional(),
    ratingStatus: z.enum(["rated", "not-rated", "pipeline-gap"]).nullable().optional(),
    safetyDisplay: z
      .object({
        gradeHold: z
          .object({
            rawGrade: z.string(),
            heldFromGenerationId: z.string().min(1),
          })
          .strict()
          .optional(),
        provisional: z.unknown().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

interface PreviewAdmission {
  preview: SafetyScoresPreview | null;
  omitted: Array<{ id: string; reason: string }>;
  /** Why a present display projection could not be admitted; absent when there was none to admit. */
  projectionUnavailableReason?: string;
}

/**
 * Names the projection refusal in build logs. A valid-but-unusable projection
 * (`display-projection-invalid`) is distinct from a version this release does
 * not know (`display-projection-version-unsupported:<version>`), which is the
 * signal that the artifact and the consumer are out of step.
 */
function describeProjectionRefusal(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "display-projection-missing";
  }
  if (!("version" in value)) return "display-projection-missing";
  const { version } = value;
  if (version === 1 || version === 2) return "display-projection-invalid";
  return version === undefined
    ? "display-projection-missing"
    : `display-projection-version-unsupported:${String(version)}`;
}

function admitSafetyScoresPreview(
  dataset: unknown,
  registry: readonly RegistryIdentity[],
  assessedAtSec: number,
): PreviewAdmission {
  const parsedDataset = SafetyScoresPreviewDatasetSchema.safeParse(dataset);
  if (!parsedDataset.success) return { preview: null, omitted: [] };
  const rawProjection = parsedDataset.data._meta?.displayProjection;
  const projection = SafetyScoresPreviewDisplayProjectionSchema.safeParse(rawProjection);
  if (!projection.success) {
    // Legacy exports and missing metadata yield no preview; a projection this
    // release cannot read is named so the build wrapper can warn about it.
    return {
      preview: null,
      omitted: [],
      projectionUnavailableReason: describeProjectionRefusal(rawProjection),
    };
  }
  const display = projection.data;
  if (display.safety === null) return { preview: null, omitted: [] };
  const safety = display.safety;
  const snapshotMidnightSec = Math.floor(Date.parse(`${display.snapshotDate}T00:00:00Z`) / 1000);
  if (!Number.isFinite(snapshotMidnightSec)) return { preview: null, omitted: [] };
  const assessedMidnightSec = Math.floor(assessedAtSec / 86_400) * 86_400;
  const ageDays = (assessedMidnightSec - snapshotMidnightSec) / 86_400;
  const replay = process.env.PHAROS_PAGES_REPLAY === "1";
  if (
    !Number.isInteger(ageDays)
    || ageDays < 0
    || (ageDays > PUBLIC_DATASET_MAX_AGE_DAYS && !replay)
    || snapshotMidnightSec > assessedAtSec
    || safety.asOfSec > safety.publishedAtSec
    || safety.publishedAtSec > display.capturedAtSec
    || display.capturedAtSec > assessedAtSec
    || safety.publishedAtSec > assessedAtSec
  ) {
    return { preview: null, omitted: [] };
  }
  // The dataset's declared Safety methodology must be the publication identity
  // that supplied these facts; two incompatible scores are never mixed.
  const methodologyLabel = parsedDataset.data._meta?.methodologyLabel;
  const methodologyVersion = safety.identity.methodologyVersion.replace(/^v/, "");
  if (
    typeof methodologyLabel !== "string"
    || !methodologyLabel.includes(`safety-score v${methodologyVersion}`)
  ) {
    return { preview: null, omitted: [] };
  }

  const registryById = new Map(registry.map((coin) => [coin.id, coin]));
  const omitted: Array<{ id: string; reason: string }> = [];
  const eligible: SafetyScoresPreviewRow[] = [];
  const seenIds = new Set<string>();
  let ratedCount = 0;
  let notRatedCount = 0;
  let pipelineGapCount = 0;

  for (const rawRow of parsedDataset.data.rows) {
    const row = SafetyScoresPreviewRowSchema.safeParse(rawRow);
    if (!row.success) continue;
    const { stablecoinId, ratingStatus } = row.data;
    if (seenIds.has(stablecoinId)) {
      // One row per asset is a publication invariant; do not publish a
      // partially reconciled census.
      return { preview: null, omitted: [] };
    }
    seenIds.add(stablecoinId);
    if (ratingStatus === null || ratingStatus === undefined) continue;
    if (ratingStatus === "not-rated") {
      if (row.data.safetyScore !== null || row.data.safetyGrade !== "NR") {
        return { preview: null, omitted };
      }
      notRatedCount += 1;
      continue;
    }
    if (ratingStatus === "pipeline-gap") {
      if (row.data.safetyScore !== null || row.data.safetyGrade !== null) {
        return { preview: null, omitted };
      }
      pipelineGapCount += 1;
      continue;
    }
    ratedCount += 1;
    const score = row.data.safetyScore;
    const grade = row.data.safetyGrade;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
      omitted.push({ id: stablecoinId, reason: "invalid-rated-score" });
      continue;
    }
    if (!isSafetyGrade(grade)) {
      omitted.push({ id: stablecoinId, reason: "invalid-rated-grade" });
      continue;
    }
    const provisional = row.data.safetyDisplay?.provisional;
    if (provisional !== undefined && provisional !== true) {
      omitted.push({ id: stablecoinId, reason: "invalid-provisional-label" });
      continue;
    }
    const gradeHold = row.data.safetyDisplay?.gradeHold ?? null;
    const rawGrade = scoreToGrade(score);
    if (gradeHold) {
      if (
        !isSafetyGrade(gradeHold.rawGrade)
        || gradeHold.rawGrade !== rawGrade
        || grade === gradeHold.rawGrade
      ) {
        omitted.push({ id: stablecoinId, reason: "invalid-grade-hold" });
        continue;
      }
    } else if (grade !== rawGrade) {
      omitted.push({ id: stablecoinId, reason: "score-grade-mismatch" });
      continue;
    }
    const identity = registryById.get(stablecoinId);
    if (!identity) {
      omitted.push({ id: stablecoinId, reason: "not-active-in-registry" });
      continue;
    }
    eligible.push({
      id: stablecoinId,
      name: identity.name,
      symbol: identity.symbol,
      href: buildStablecoinUrl(stablecoinId),
      grade,
      score,
      provisional: provisional === true,
      gradeHoldRawGrade: gradeHold ? (gradeHold.rawGrade as SafetyGrade) : null,
    });
  }

  const completeness = safety.completeness;
  if (
    ratedCount !== completeness.ratedCount
    || notRatedCount !== completeness.notRatedCount
    || pipelineGapCount !== completeness.pipelineGapCount
  ) {
    return { preview: null, omitted };
  }
  if (eligible.length === 0) return { preview: null, omitted };

  eligible.sort((left, right) => right.score - left.score
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const rows = eligible.slice(0, 20);
  return {
    preview: {
      kind: "safety-grade-preview",
      rows,
      shownCount: rows.length,
      eligibleRatedCount: eligible.length,
      publicationCompleteness: {
        expectedCount: completeness.expectedCount,
        ratedCount: completeness.ratedCount,
        notRatedCount: completeness.notRatedCount,
        pipelineGapCount: completeness.pipelineGapCount,
      },
      publicationHealth: safety.publicationHealth,
      identity: safety.identity,
      publishedAtSec: safety.publishedAtSec,
      capturedAtSec: display.capturedAtSec,
      snapshotDate: display.snapshotDate,
      expiresAtSec: snapshotMidnightSec + (PUBLIC_DATASET_MAX_AGE_DAYS + 1) * 86_400,
    },
    omitted,
  };
}

/**
 * Builds the bounded dated top-20 Safety preview from the exported
 * scores-latest dataset. Returns null when the global contract fails, the
 * dataset predates the display projection, or no rated active asset survives.
 */
export function buildSafetyScoresPreview(
  dataset: unknown,
  registry: readonly RegistryIdentity[],
  assessedAtSec: number,
): SafetyScoresPreview | null {
  return admitSafetyScoresPreview(dataset, registry, assessedAtSec).preview;
}

/** Committed-data wrapper used by the Safety Scores page at build time. */
export function getSafetyScoresPreview(): SafetyScoresPreview | null {
  const admission = admitSafetyScoresPreview(
    SCORES_LATEST_DATASET,
    ACTIVE_STABLECOINS,
    Math.floor(Date.now() / 1000),
  );
  if (admission.projectionUnavailableReason) {
    console.warn(
      `[safety-grade-preview] dated preview unavailable (${admission.projectionUnavailableReason})`,
    );
  }
  if (admission.omitted.length > 0) {
    console.warn(
      "[safety-grade-preview] omitted rated rows: "
        + admission.omitted.map((entry) => `${entry.id} (${entry.reason})`).join(", "),
    );
  }
  return admission.preview;
}
