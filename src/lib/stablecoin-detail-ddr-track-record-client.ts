import { formatElapsedSeconds, formatIsoDate } from "@shared/lib/format";
import { median } from "@shared/lib/stats";
import {
  DDRR_PUBLIC_WARNING,
  type DdrrResponse,
  type DdrrRow,
} from "@shared/types/depeg-resolver-review";
import {
  DDR_COVERAGE_LABELS,
  DDR_COVERAGE_TONES,
  DDR_DURATION_LABELS,
  DDR_OUTCOME_LABELS,
  DDR_VERDICT_LABELS,
  DDR_VERDICT_TONES,
  AMBER_TONE,
  EMERALD_TONE,
  MUTED_TONE,
  RED_TONE,
  SKY_TONE,
  ddrSourceEventStateToActualOutcome,
  formatDdrSignedDuration,
  isDdrCorrectVerdict,
  isDdrMissVerdict,
  isDdrScoredVerdict,
} from "@/lib/depeg-resolver-review-presentation";

/**
 * Per-coin projection of the DDRR review feed for the detail page's track-record
 * module: the frozen DDR forecasts Pharos published for this coin, graded against
 * what actually happened.
 *
 * Shared presentation vocabulary keeps this projection aligned with the /depeg
 * reviewer. This module adds no new review semantics; DDR's own forward-looking
 * forecast stays with the detail page's resolver card.
 */
export interface DdrTrackRecordIncidentRow {
  key: string;
  /** Incident start, epoch seconds — the ordering key and the displayed date. */
  startedAt: number;
  dateLabel: string;
  outcomeLabel: string;
  outcomeToneClass: string;
  actualOutcomeLabel: string;
  durationLabel: string;
  /** Erratum marker for invalidated publications, e.g. "2 errata". */
  erratumLabel: string | null;
}

export interface DdrTrackRecordSummary {
  chipLabel: string;
  chipToneClass: string;
  lede: string;
  /** Frozen public predictions reviewed for this coin. */
  reviewedForecastCount: number;
  /** Reviewed forecasts whose recovery call has been graded. */
  scoredCount: number;
  correctCount: number;
  missCount: number;
  pendingCount: number;
  noCallCount: number;
  /** Incidents that closed without any published call (coverage rows). */
  notCalledCount: number;
  invalidatedCount: number;
  durationScoredCount: number;
  medianAbsoluteDurationErrorLabel: string | null;
  incidents: DdrTrackRecordIncidentRow[];
  hiddenIncidentCount: number;
  reviewedAt: string | null;
  publicWarning: string;
}

/** Incident rows rendered inline; the rest fold into a count with a /depeg link. */
const INCIDENT_DISPLAY_LIMIT = 6;

function getActualOutcomeLabel(row: DdrrRow): string {
  const outcome =
    row.kind === "prediction_review" || row.kind === "no_call_review"
      ? row.actual.kind
      : ddrSourceEventStateToActualOutcome(row.sourceEventState);
  return DDR_OUTCOME_LABELS[outcome];
}

function getOutcomeChip(row: DdrrRow): { label: string; toneClass: string } {
  switch (row.kind) {
    case "prediction_review":
      return {
        label: DDR_VERDICT_LABELS[row.verdictReview],
        toneClass: DDR_VERDICT_TONES[row.verdictReview],
      };
    case "no_call_review":
      return { label: "no-call", toneClass: MUTED_TONE };
    case "invalidated_prediction":
      return { label: "invalidated", toneClass: RED_TONE };
    case "coverage":
      return {
        label: DDR_COVERAGE_LABELS[row.predictionState],
        toneClass: DDR_COVERAGE_TONES[row.predictionState],
      };
  }
}

function getDurationLabel(row: DdrrRow): string {
  if (row.kind !== "prediction_review") return DDR_DURATION_LABELS.duration_unscored;
  const label = DDR_DURATION_LABELS[row.durationReview];
  const signed = row.signedDurationErrorSec;
  return signed != null && Number.isFinite(signed) ? `${formatDdrSignedDuration(signed)} ${label}` : label;
}

function getErratumLabel(row: DdrrRow): string | null {
  if (row.kind !== "invalidated_prediction") return null;
  const count = Number.isFinite(row.errataCount) ? row.errataCount : 0;
  if (count <= 0) return null;
  return count === 1 ? "1 erratum" : `${count} errata`;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function buildLede(summary: {
  reviewedForecastCount: number;
  scoredCount: number;
  correctCount: number;
  notCalledCount: number;
  medianAbsoluteDurationErrorLabel: string | null;
}): string {
  const { reviewedForecastCount, scoredCount, correctCount, notCalledCount } = summary;
  let lede =
    reviewedForecastCount > 0
      ? `${reviewedForecastCount} frozen DDR ${pluralize(reviewedForecastCount, "forecast", "forecasts")} published for this coin, graded against the confirmed outcome.`
      : "No frozen DDR forecast for this coin has been graded yet.";
  if (scoredCount > 0) {
    lede += ` ${correctCount} of ${scoredCount} scored recovery ${pluralize(scoredCount, "call", "calls")} correct.`;
  }
  if (summary.medianAbsoluteDurationErrorLabel != null) {
    lede += ` Median duration miss ${summary.medianAbsoluteDurationErrorLabel}.`;
  }
  if (notCalledCount > 0) {
    lede += ` ${notCalledCount} ${pluralize(notCalledCount, "incident", "incidents")} carried no published call.`;
  }
  return lede;
}

function buildChip(counts: {
  scoredCount: number;
  correctCount: number;
  reviewedForecastCount: number;
}): { label: string; toneClass: string } {
  const { scoredCount, correctCount, reviewedForecastCount } = counts;
  if (scoredCount > 0) {
    const toneClass = correctCount === scoredCount ? EMERALD_TONE : correctCount > 0 ? AMBER_TONE : RED_TONE;
    return { label: `${correctCount}/${scoredCount} correct`, toneClass };
  }
  if (reviewedForecastCount > 0) {
    return { label: `${reviewedForecastCount} maturing`, toneClass: SKY_TONE };
  }
  return { label: "Unscored", toneClass: MUTED_TONE };
}

/**
 * Builds the coin's track record, or null when the review feed carries no
 * reviewed publication for it. Coverage-only coins render nothing: coverage rows
 * are accountability context around a record, never a record on their own.
 */
export function projectDdrTrackRecordSummary(
  data: DdrrResponse | undefined,
  stablecoinId: string,
): DdrTrackRecordSummary | null {
  if (!data || !Array.isArray(data.rows) || !stablecoinId) return null;

  const rows = data.rows.filter(
    (row): row is DdrrRow =>
      row != null && row.stablecoinId === stablecoinId && Number.isFinite(row.startedAt),
  );
  if (!rows.some((row) => row.kind !== "coverage")) return null;

  const predictionRows = rows.filter((row) => row.kind === "prediction_review");
  const scoredRows = predictionRows.filter((row) => isDdrScoredVerdict(row.verdictReview));
  const durationErrors = predictionRows
    .map((row) => row.absoluteDurationErrorSec)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const medianAbsoluteDurationErrorSec = median(durationErrors);

  const counts = {
    reviewedForecastCount: predictionRows.length,
    scoredCount: scoredRows.length,
    correctCount: scoredRows.filter((row) => isDdrCorrectVerdict(row.verdictReview)).length,
    missCount: scoredRows.filter((row) => isDdrMissVerdict(row.verdictReview)).length,
    pendingCount: predictionRows.filter((row) => row.verdictReview === "pending").length,
    noCallCount: rows.filter((row) => row.kind === "no_call_review").length,
    notCalledCount: rows.filter((row) => row.kind === "coverage").length,
    invalidatedCount: rows.filter((row) => row.kind === "invalidated_prediction").length,
  };

  const medianAbsoluteDurationErrorLabel =
    medianAbsoluteDurationErrorSec != null ? formatElapsedSeconds(Math.round(medianAbsoluteDurationErrorSec)) : null;

  // Newest incident first; the event id breaks ties between same-day incidents.
  const ordered = [...rows].sort((a, b) => b.startedAt - a.startedAt || b.eventId - a.eventId);
  const incidents = ordered.slice(0, INCIDENT_DISPLAY_LIMIT).map((row) => {
    const chip = getOutcomeChip(row);
    return {
      key: `${row.eventId}:${row.kind}:${row.startedAt}`,
      startedAt: row.startedAt,
      dateLabel: formatIsoDate(row.startedAt),
      outcomeLabel: chip.label,
      outcomeToneClass: chip.toneClass,
      actualOutcomeLabel: getActualOutcomeLabel(row),
      durationLabel: getDurationLabel(row),
      erratumLabel: getErratumLabel(row),
    };
  });

  const computedAt = data._meta?.computedAt;
  const chip = buildChip(counts);

  return {
    chipLabel: chip.label,
    chipToneClass: chip.toneClass,
    lede: buildLede({ ...counts, medianAbsoluteDurationErrorLabel }),
    ...counts,
    durationScoredCount: durationErrors.length,
    medianAbsoluteDurationErrorLabel,
    incidents,
    hiddenIncidentCount: ordered.length - incidents.length,
    reviewedAt: computedAt != null && Number.isFinite(computedAt) ? formatIsoDate(computedAt) : null,
    publicWarning: data._meta?.publicWarning ?? DDRR_PUBLIC_WARNING,
  };
}
