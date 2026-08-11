import { formatElapsedSeconds, formatIsoDate } from "@shared/lib/format";
import {
  DDRR_PUBLIC_WARNING,
  type DdrrActualOutcome,
  type DdrrCoveragePredictionState,
  type DdrrDurationReview,
  type DdrrResponse,
  type DdrrRow,
  type DdrrVerdictReview,
} from "@shared/types/depeg-resolver-review";

/**
 * Per-coin projection of the DDRR review feed for the detail page's track-record
 * module: the frozen DDR forecasts Pharos published for this coin, graded against
 * what actually happened.
 *
 * The vocabulary (verdict, coverage, outcome and duration labels plus their tone
 * strings) is copied verbatim from the /depeg reviewer module so both surfaces
 * name the same outcome the same way; this projection adds no new semantics. It
 * only reads the review feed — DDR's own forward-looking forecast stays with the
 * detail page's resolver card.
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

const MUTED_TONE = "border-border bg-muted text-muted-foreground";
const EMERALD_TONE = "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
const AMBER_TONE = "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
const RED_TONE = "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400";
const SKY_TONE = "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400";
const VIOLET_TONE = "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400";

const VERDICT_LABELS: Record<DdrrVerdictReview, string> = {
  correct_recoverable: "Correct recoverable",
  correct_terminal: "Correct terminal",
  false_terminal: "False terminal",
  false_recoverable: "False recoverable",
  risk_noted_terminal: "Risk noted",
  unscored_insufficient_signal: "Unscored",
  pending: "Pending",
  data_issue: "Data issue",
};

const VERDICT_TONES: Record<DdrrVerdictReview, string> = {
  correct_recoverable: EMERALD_TONE,
  correct_terminal: EMERALD_TONE,
  false_terminal: RED_TONE,
  false_recoverable: RED_TONE,
  risk_noted_terminal: AMBER_TONE,
  unscored_insufficient_signal: MUTED_TONE,
  pending: SKY_TONE,
  data_issue: MUTED_TONE,
};

const COVERAGE_LABELS: Record<DdrrCoveragePredictionState, string> = {
  pending_lock: "pending lock",
  lock_deferred: "lock deferred",
  data_quality_gap: "data quality gap",
  orphan_closed: "orphan closed",
  publication_retry_pending: "publication retry",
  resolved_before_prediction: "resolved before lock",
  terminal_before_prediction: "terminal before lock",
  missed_lock_recovered: "missed recovered",
  missed_lock_terminal: "missed terminal",
  publication_failed: "publication failed",
};

const COVERAGE_TONES: Record<DdrrCoveragePredictionState, string> = {
  pending_lock: SKY_TONE,
  lock_deferred: AMBER_TONE,
  data_quality_gap: MUTED_TONE,
  orphan_closed: MUTED_TONE,
  publication_retry_pending: VIOLET_TONE,
  resolved_before_prediction: "border-border bg-background text-muted-foreground",
  terminal_before_prediction: "border-border bg-background text-muted-foreground",
  missed_lock_recovered: RED_TONE,
  missed_lock_terminal: RED_TONE,
  publication_failed: RED_TONE,
};

const OUTCOME_LABELS: Record<DdrrActualOutcome, string> = {
  recovered: "recovered",
  terminal: "terminal observed",
  orphan_closed: "closed without recovery",
  still_open: "still open",
  source_missing: "source missing",
  data_issue: "data issue",
  invalidated: "invalidated",
};

const DURATION_LABELS: Record<DdrrDurationReview, string> = {
  inside_band: "inside band",
  faster_than_band: "faster than band",
  slower_than_band: "slower than band",
  median_late_by: "late vs median",
  median_early_by: "early vs median",
  median_exact: "exact median",
  duration_unscored: "unscored",
  data_issue: "data issue",
};

/** Verdict reviews that count as a real, scored result (vs. still maturing). */
const SCORED_VERDICTS = new Set<DdrrVerdictReview>([
  "correct_recoverable",
  "correct_terminal",
  "false_terminal",
  "false_recoverable",
  "risk_noted_terminal",
]);

const CORRECT_VERDICTS = new Set<DdrrVerdictReview>(["correct_recoverable", "correct_terminal"]);
const MISS_VERDICTS = new Set<DdrrVerdictReview>(["false_terminal", "false_recoverable"]);

function formatSignedDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded === 0) return "0s";
  return `${rounded > 0 ? "+" : "−"}${formatElapsedSeconds(Math.abs(rounded))}`;
}

function sourceEventStateToActualOutcome(sourceEventState: DdrrRow["sourceEventState"]): DdrrActualOutcome {
  switch (sourceEventState) {
    case "active":
      return "still_open";
    case "missing":
      return "source_missing";
    default:
      return sourceEventState;
  }
}

function getActualOutcomeLabel(row: DdrrRow): string {
  const outcome =
    row.kind === "prediction_review" || row.kind === "no_call_review"
      ? row.actual.kind
      : sourceEventStateToActualOutcome(row.sourceEventState);
  return OUTCOME_LABELS[outcome] ?? outcome;
}

function getOutcomeChip(row: DdrrRow): { label: string; toneClass: string } {
  switch (row.kind) {
    case "prediction_review":
      return {
        label: VERDICT_LABELS[row.verdictReview] ?? row.verdictReview,
        toneClass: VERDICT_TONES[row.verdictReview] ?? MUTED_TONE,
      };
    case "no_call_review":
      return { label: "no-call", toneClass: MUTED_TONE };
    case "invalidated_prediction":
      return { label: "invalidated", toneClass: RED_TONE };
    case "coverage":
      return {
        label: COVERAGE_LABELS[row.predictionState] ?? row.predictionState,
        toneClass: COVERAGE_TONES[row.predictionState] ?? MUTED_TONE,
      };
  }
}

function getDurationLabel(row: DdrrRow): string {
  if (row.kind !== "prediction_review") return DURATION_LABELS.duration_unscored;
  const label = DURATION_LABELS[row.durationReview] ?? row.durationReview;
  const signed = row.signedDurationErrorSec;
  return signed != null && Number.isFinite(signed) ? `${formatSignedDuration(signed)} ${label}` : label;
}

function getErratumLabel(row: DdrrRow): string | null {
  if (row.kind !== "invalidated_prediction") return null;
  const count = Number.isFinite(row.errataCount) ? row.errataCount : 0;
  if (count <= 0) return null;
  return count === 1 ? "1 erratum" : `${count} errata`;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
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
  const scoredRows = predictionRows.filter((row) => SCORED_VERDICTS.has(row.verdictReview));
  const durationErrors = predictionRows
    .map((row) => row.absoluteDurationErrorSec)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const medianAbsoluteDurationErrorSec = median(durationErrors);

  const counts = {
    reviewedForecastCount: predictionRows.length,
    scoredCount: scoredRows.length,
    correctCount: scoredRows.filter((row) => CORRECT_VERDICTS.has(row.verdictReview)).length,
    missCount: scoredRows.filter((row) => MISS_VERDICTS.has(row.verdictReview)).length,
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
