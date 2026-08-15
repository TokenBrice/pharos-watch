import { formatElapsedSeconds } from "@shared/lib/format";
import type {
  DdrrActualOutcome,
  DdrrDurationReview,
  DdrrRow,
  DdrrVerdictReview,
} from "@shared/types/depeg-resolver-review";

export type DdrrCoverageState = Exclude<DdrrRow["predictionState"], "frozen">;

const MUTED_TONE = "border-border bg-muted text-muted-foreground";
const EMERALD_TONE = "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
const AMBER_TONE = "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
const RED_TONE = "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400";
const SKY_TONE = "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400";

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
  publication_retry_pending: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
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

const SCORED_VERDICTS: ReadonlySet<DdrrVerdictReview> = new Set([
  "correct_recoverable",
  "correct_terminal",
  "false_terminal",
  "false_recoverable",
  "risk_noted_terminal",
]);
const CORRECT_VERDICTS: ReadonlySet<DdrrVerdictReview> = new Set(["correct_recoverable", "correct_terminal"]);
const MISS_VERDICTS: ReadonlySet<DdrrVerdictReview> = new Set(["false_terminal", "false_recoverable"]);

export function isDdrScoredVerdict(verdict: DdrrVerdictReview): boolean {
  return SCORED_VERDICTS.has(verdict);
}

export function isDdrCorrectVerdict(verdict: DdrrVerdictReview): boolean {
  return CORRECT_VERDICTS.has(verdict);
}

export function isDdrMissVerdict(verdict: DdrrVerdictReview): boolean {
  return MISS_VERDICTS.has(verdict);
}

export function formatDdrSignedDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "N/A";
  const rounded = Math.round(seconds);
  if (rounded === 0) return "0s";
  return `${rounded > 0 ? "+" : "−"}${formatElapsedSeconds(Math.abs(rounded))}`;
}

export function ddrSourceEventStateToActualOutcome(
  sourceEventState: DdrrRow["sourceEventState"],
): DdrrActualOutcome {
  switch (sourceEventState) {
    case "active":
      return "still_open";
    case "missing":
      return "source_missing";
    case "recovered":
    case "terminal":
    case "orphan_closed":
    case "data_issue":
    case "invalidated":
      return sourceEventState;
  }
}
