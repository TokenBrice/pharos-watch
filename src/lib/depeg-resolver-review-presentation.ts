import { actualOutcomeFromSourceEventState } from "@shared/lib/depeg-resolver-review";
import { formatElapsedSeconds, formatPercentFromRatio } from "@shared/lib/format";
import { DDR_REVIEW_TONE_CLASSES } from "@shared/lib/classification";
import { DDR_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { DDRR_SCORED_VERDICTS } from "@shared/types/depeg-resolver-review";
import type {
  DdrrActualOutcome,
  DdrrDurationReview,
  DdrrResponseRow,
  DdrrSummary,
  DdrrVerdictReview,
} from "@shared/types/depeg-resolver-review";

export type DdrrCoverageState = Exclude<DdrrResponseRow["predictionState"], "frozen">;

const MUTED_TONE = "border-border bg-muted text-muted-foreground";
const EMERALD_TONE = DDR_REVIEW_TONE_CLASSES.positive;
const AMBER_TONE = DDR_REVIEW_TONE_CLASSES.watch;
const RED_TONE = DDR_REVIEW_TONE_CLASSES.negative;
const SKY_TONE = DDR_REVIEW_TONE_CLASSES.pending;

export { AMBER_TONE, EMERALD_TONE, MUTED_TONE, RED_TONE, SKY_TONE };

export const DDR_VERDICT_LABELS: Readonly<Record<DdrrVerdictReview, string>> = {
  correct_recoverable: "Correct recoverable",
  correct_terminal: "Correct terminal",
  false_terminal: "False terminal",
  false_recoverable: "False recoverable",
  risk_noted_terminal: "Risk noted",
  unscored_insufficient_signal: "Unscored",
  pending: "Pending",
  data_issue: "Data issue",
};

export const DDR_VERDICT_TONES: Readonly<Record<DdrrVerdictReview, string>> = {
  correct_recoverable: EMERALD_TONE,
  correct_terminal: EMERALD_TONE,
  false_terminal: RED_TONE,
  false_recoverable: RED_TONE,
  risk_noted_terminal: AMBER_TONE,
  unscored_insufficient_signal: MUTED_TONE,
  pending: SKY_TONE,
  data_issue: MUTED_TONE,
};

export const DDR_COVERAGE_LABELS: Readonly<Record<DdrrCoverageState, string>> = {
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
  no_call: "no-call",
  invalidated: "invalidated",
};

export const DDR_COVERAGE_TONES: Readonly<Record<DdrrCoverageState, string>> = {
  pending_lock: SKY_TONE,
  lock_deferred: AMBER_TONE,
  data_quality_gap: MUTED_TONE,
  orphan_closed: MUTED_TONE,
  publication_retry_pending: DDR_REVIEW_TONE_CLASSES.retry,
  resolved_before_prediction: "border-border bg-background text-muted-foreground",
  terminal_before_prediction: "border-border bg-background text-muted-foreground",
  missed_lock_recovered: RED_TONE,
  missed_lock_terminal: RED_TONE,
  publication_failed: RED_TONE,
  no_call: MUTED_TONE,
  invalidated: RED_TONE,
};

export const DDR_OUTCOME_LABELS: Readonly<Record<DdrrActualOutcome, string>> = {
  recovered: "recovered",
  terminal: "terminal observed",
  orphan_closed: "closed without recovery",
  still_open: "still open",
  source_missing: "source missing",
  data_issue: "data issue",
  invalidated: "invalidated",
};

export const DDR_DURATION_LABELS: Readonly<Record<DdrrDurationReview, string>> = {
  inside_band: "inside band",
  faster_than_band: "faster than band",
  slower_than_band: "slower than band",
  median_late_by: "late vs median",
  median_early_by: "early vs median",
  median_exact: "exact median",
  duration_unscored: "unscored",
  data_issue: "data issue",
};

export function isDdrScoredVerdict(verdict: DdrrVerdictReview): boolean {
  return DDRR_SCORED_VERDICTS.has(verdict);
}

export function formatDdrSignedDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "N/A";
  const rounded = Math.round(seconds);
  if (rounded === 0) return "0s";
  return `${rounded > 0 ? "+" : "−"}${formatElapsedSeconds(Math.abs(rounded))}`;
}

export function isScored(row: DdrrResponseRow): boolean {
  return row.kind === "prediction_review" && isDdrScoredVerdict(row.verdictReview);
}

export function isTrackRecordRow(row: DdrrResponseRow): boolean {
  return row.kind === "prediction_review";
}

export function formatReviewerPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return formatPercentFromRatio(value, Number.isInteger(value * 100) ? 0 : 1);
}

export function getCoverageState(row: DdrrResponseRow): DdrrCoverageState | null {
  return row.predictionState === "frozen" ? null : row.predictionState;
}

export function formatMetricPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatReviewerPercent(value);
}

export function getVerdictReview(row: DdrrResponseRow): DdrrVerdictReview {
  if (row.kind === "prediction_review" || row.kind === "no_call_review") return row.verdictReview;
  return "pending";
}

export function getDurationReview(row: DdrrResponseRow): DdrrDurationReview {
  if (row.kind === "prediction_review" || row.kind === "no_call_review") return row.durationReview;
  return "duration_unscored";
}

export function getActualOutcome(row: DdrrResponseRow): DdrrActualOutcome {
  if (row.kind === "prediction_review" || row.kind === "no_call_review") {
    return row.actual.kind;
  }
  if (row.kind === "coverage") {
    return row.actualOutcome ?? actualOutcomeFromSourceEventState(row.sourceEventState);
  }
  // Invalidated rows carry the outcome natively: their prediction state (and
  // the producer's sourceEventState) is the literal "invalidated".
  return row.predictionState;
}
export function getRowContextLabel(row: DdrrResponseRow): string {
  switch (row.kind) {
    case "prediction_review":
      return "Public prediction";
    case "no_call_review":
      return "No-call";
    case "invalidated_prediction":
      return row.originalKind === "no_call" ? "Invalidated no-call" : "Invalidated prediction";
    case "coverage":
      return "Coverage";
  }
}

export function getRowTime(row: DdrrResponseRow): number {
  switch (row.kind) {
    case "prediction_review":
    case "no_call_review":
      return row.publishedAt;
    case "invalidated_prediction":
      return row.publishedAt ?? row.lockedAt;
    case "coverage":
      return row.actualEndedAt ?? row.terminalEvidenceAt ?? row.eligibleAt ?? row.startedAt;
  }
}

export function getSignedDurationError(row: DdrrResponseRow): number | null {
  return row.kind === "prediction_review" ? row.signedDurationErrorSec : null;
}

export type NodeKind = "correct" | "miss" | "risk" | "pending" | "muted";

export function nodeKind(verdict: DdrrVerdictReview): NodeKind {
  switch (verdict) {
    case "correct_recoverable":
    case "correct_terminal":
      return "correct";
    case "false_terminal":
    case "false_recoverable":
      return "miss";
    case "risk_noted_terminal":
      return "risk";
    case "pending":
      return "pending";
    default:
      return "muted";
  }
}

export interface DdrTimelineModel {
  rows: DdrrResponseRow[];
  correct: number;
  miss: number;
  pending: number;
}

export function buildDdrTimelineModel(rows: readonly DdrrResponseRow[], limit: number): DdrTimelineModel {
  const ordered = [...rows].sort((a, b) => getRowTime(a) - getRowTime(b)).slice(-limit);
  return {
    rows: ordered,
    correct: ordered.filter((row) => nodeKind(getVerdictReview(row)) === "correct").length,
    miss: ordered.filter((row) => nodeKind(getVerdictReview(row)) === "miss").length,
    pending: ordered.filter((row) => nodeKind(getVerdictReview(row)) === "pending").length,
  };
}

export interface VersionAccuracySegment {
  major: string;
  scored: number;
  correct: number;
  accuracy: number | null;
  durationScored: number;
  meanSignedDurationErrorSec: number | null;
  meanAbsoluteDurationErrorSec: number | null;
}

/**
 * Consolidates the summary's per-(methodology, policy) segments into
 * methodology majors (v2, v3, …) for the version track-record strip. The
 * current major always appears, even before any of its rows have matured.
 * Duration means are recombined weighted by each segment's scored count.
 */
export function summarizeAccuracyByMajor(summary: DdrrSummary): VersionAccuracySegment[] {
  const majors = new Map<
    string,
    { scored: number; correct: number; durationScored: number; signedSum: number; absoluteSum: number }
  >();
  for (const segment of summary.byPredictionPolicy) {
    if (segment.segmentKind !== "prediction_policy" || segment.predictionMethodologyVersion == null) {
      continue;
    }
    const major = segment.predictionMethodologyVersion.split(".")[0];
    const entry =
      majors.get(major) ?? { scored: 0, correct: 0, durationScored: 0, signedSum: 0, absoluteSum: 0 };
    entry.scored += segment.metrics.recoveryLikelihoodScoredCount;
    entry.correct += segment.metrics.recoveryLikelihoodCorrectCount;
    const durationScored = segment.metrics.durationScoredCount;
    if (durationScored > 0 && segment.metrics.meanSignedDurationErrorSec != null) {
      entry.durationScored += durationScored;
      entry.signedSum += segment.metrics.meanSignedDurationErrorSec * durationScored;
      entry.absoluteSum += (segment.metrics.meanAbsoluteDurationErrorSec ?? 0) * durationScored;
    }
    majors.set(major, entry);
  }
  const currentMajor = DDR_METHODOLOGY_VERSION.split(".")[0];
  if (!majors.has(currentMajor)) {
    majors.set(currentMajor, { scored: 0, correct: 0, durationScored: 0, signedSum: 0, absoluteSum: 0 });
  }
  return [...majors.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([major, { scored, correct, durationScored, signedSum, absoluteSum }]) => ({
      major: `v${major}`,
      scored,
      correct,
      accuracy: scored > 0 ? correct / scored : null,
      durationScored,
      meanSignedDurationErrorSec: durationScored > 0 ? signedSum / durationScored : null,
      meanAbsoluteDurationErrorSec: durationScored > 0 ? absoluteSum / durationScored : null,
    }));
}

export type CoverageMetricKey =
  | "scoreableCoveragePct"
  | "predictionCoveragePct"
  | "publicationSuccessPct"
  | "noCallSharePct"
  | "invalidationRatePct";

export function getCoverageMetric(
  metrics: DdrrSummary["headline"],
  key: CoverageMetricKey,
): number | null {
  if (key === "scoreableCoveragePct") {
    const denominator = metrics.policyUniverseIncidentCount;
    return denominator > 0 ? metrics.recoveryLikelihoodScoredCount / denominator : null;
  }

  if (key === "publicationSuccessPct") {
    const published = metrics.lockedPredictionCount;
    const retryPending = metrics.publicationRetryPendingCount;
    const failed = metrics.publicationFailedCount;
    const denominator = published + retryPending + failed;
    return denominator > 0 ? published / denominator : null;
  }

  const v2Key =
    key === "predictionCoveragePct"
      ? "predictionRatePct"
      : key === "noCallSharePct"
        ? "noCallRatePct"
        : key === "invalidationRatePct"
          ? "invalidatedPct"
          : null;
  return v2Key ? metrics[v2Key] : null;
}

export interface DdrReviewerRowsModel {
  shownRows: DdrrResponseRow[];
  hiddenCount: number;
  trackRecordRows: DdrrResponseRow[];
}

export function buildDdrReviewerRows(rows: readonly DdrrResponseRow[], displayLimit: number): DdrReviewerRowsModel {
  // Scored rows carry the signal; surface them first, then a capped run of maturing rows.
  const orderedRows = [...rows].sort((a, b) => Number(isScored(b)) - Number(isScored(a)));
  const shownRows = orderedRows.slice(0, displayLimit);
  return {
    shownRows,
    hiddenCount: orderedRows.length - shownRows.length,
    trackRecordRows: rows.filter(isTrackRecordRow),
  };
}
